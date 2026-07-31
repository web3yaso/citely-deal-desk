/**
 * **单一编排入口**：一笔交易输入进来，全流程跑完，返回签名过的 SA。
 *
 * ```
 * intake → 8183 开案 → x402 采购 → 判定 → 五出口路由 → Policy Engine →
 * SA 生成与签名 → submit → 三检 → 收口 → 账本
 * ```
 *
 * 服务侧（HTTP）与演示侧共用这一条主线，差别只在**注入的实现**
 * （`jobClient` / `x402` / `verify` / `settle` / 判定器 provider）。
 *
 * ## 三条硬纪律
 *
 * 1. **幂等**：同一 `caseId` 重发不会重复建 Job、重复付费、重复入账。
 *    请求级在 `case_runs` + `KeyedMutex`，链上写在 `tx_log`，采购在 `purchases`，
 *    入账在 `ledger` 的 UNIQUE 约束——四层各管一段，缺一层就有一类重复。
 * 2. **不变量 2**：`condition` 只从 Module 结果推导。判定器 verdict 经
 *    `toItemVerdicts` 进 `basis[]` 与 `confidence`，本文件没有第二条路径。
 * 3. **`sa_hash` 稳定**：`expires_at` 从**链上回读**，编排里不出现墙上时钟；
 *    `signed_at` 只进 `attestation`（不进哈希）。
 */

import type { JobFeeRates } from "@citely/chain/types";

import { adjudicateRubric, toItemVerdicts } from "../adjudicator/rubric-run.js";
import type { AdjudicatedItem } from "../adjudicator/rubric-run.js";
import { itemsNeedingEscalation, routeExit } from "../routing/exits.js";
import type { ExitDecision } from "../routing/exits.js";
import { sha256Canonical } from "../util/hash.js";
import { createLogger, redactSecrets } from "../util/logger.js";
import type { Logger } from "../util/logger.js";
import { usdc6ToAtomicString } from "../util/usdc6.js";
import { KeyedMutex } from "./keyed-mutex.js";
import { procureOnce } from "./purchase-store.js";
import type { PurchaseRecord } from "./purchase-store.js";
import {
  advanceCaseState,
  assembleSa,
  buildCaseEscalation,
  buildSettlementLegs,
  completeLedger,
  deriveIntakeStatus,
  intake,
  procurementLedger,
  recordLedgerIdempotent,
  toRoutingSummaries,
} from "./stages.js";
import type {
  CaseRequest,
  CaseResult,
  CaseRunSnapshot,
  RunCaseDeps,
  SettlementActionView,
  VerificationReportView,
} from "./types.js";

const defaultLog = createLogger("orchestrator");

/**
 * 同 `caseId` 的进程内串行锁。
 *
 * 模块级单例是**有意的**：请求级幂等要的正是"同一个进程里同一个案件只跑一份"，
 * 而 HTTP 服务的多个请求本来就在同一个进程里。跨进程那一半由 `case_runs` 承担。
 */
const caseMutex = new KeyedMutex();

/** 受理失败（出口 1）：材料不可解析或超出 rubric 范围。 */
export class IntakeRejectedError extends Error {
  public readonly caseId: string;
  public readonly decision: ExitDecision;

  public constructor(caseId: string, decision: ExitDecision) {
    super(`case ${caseId} failed intake: ${decision.reason}`);
    this.name = "IntakeRejectedError";
    this.caseId = caseId;
    this.decision = decision;
  }
}

/** 命中出口 4 却没给升级配置——产不出卷宗与 Review Job 模板，只能响亮失败。 */
export class EscalationConfigMissingError extends Error {
  public constructor(caseId: string, itemIds: readonly string[]) {
    super(
      `case ${caseId} routed to exit 4 (interpretive gray) for items [${itemIds.join(", ")}] ` +
        `but no escalation config was provided`,
    );
    this.name = "EscalationConfigMissingError";
  }
}

/**
 * 请求指纹：同 `caseId` 必须配同一份请求参数，否则视为冲突。
 *
 * **逐字段显式投影**而不是直接规范化整个对象：`Usdc6` 是 bigint 分支类型、
 * `expiresAt` 是 `Date`，两者都过不了 `canonicalJson`。显式投影还有一个好处——
 * 将来往请求里加字段时，"它算不算幂等键的一部分"必须被明确回答一次。
 *
 * @param request - 案件请求
 * @returns 规范化 JSON 的 sha256
 */
export function requestFingerprint(request: CaseRequest): string {
  const escalation = request.escalation;
  return sha256Canonical({
    case_id: request.caseId,
    deal: request.deal,
    rubric: { id: request.rubric.id, body: request.rubric.rubric },
    module: {
      id: request.module.id,
      quoted_price_atomic: usdc6ToAtomicString(request.module.quotedPriceAtomic),
    },
    job: {
      provider: request.job.provider,
      evaluator: request.job.evaluator,
      expired_at: request.job.expiredAt.toString(),
      budget_atomic: usdc6ToAtomicString(request.job.budgetAtomic),
      description: request.job.description ?? null,
    },
    settlement: {
      party: request.settlement.party,
      payee: request.settlement.payee,
      amount_atomic: usdc6ToAtomicString(request.settlement.amountAtomic),
    },
    chain_id: request.chainId,
    escalation:
      escalation === undefined
        ? null
        : {
            client: escalation.client,
            provider: escalation.provider,
            evaluator: escalation.evaluator,
            expires_at: escalation.expiresAt.toISOString(),
            deposit_atomic: usdc6ToAtomicString(escalation.deposit),
          },
  });
}

/**
 * 跑完一个案件。
 *
 * @param request - 案件事实与商务参数（`caseId` 即幂等键）
 * @param deps - 注入的链上客户端、仓储、判定器、采购、三检与收口实现
 * @returns 案件结果（含签名 SA、三检结论、收口动作与账本行）
 * @throws {CaseRequestConflictError} 同 `caseId` 换了请求参数
 * @throws {CaseRunInFlightError} 同 `caseId` 正在别的进程里跑
 * @throws {IntakeRejectedError} 受理失败（出口 1）——此时**不产生任何链上写操作**
 * @throws {EscalationConfigMissingError} 命中出口 4 但没给升级配置
 */
export async function runCase<TReport extends VerificationReportView = VerificationReportView>(
  request: CaseRequest,
  deps: RunCaseDeps<TReport>,
): Promise<CaseResult> {
  return await caseMutex.runExclusive(request.caseId, async () => await runExclusive(request, deps));
}

async function runExclusive<TReport extends VerificationReportView>(
  request: CaseRequest,
  deps: RunCaseDeps<TReport>,
): Promise<CaseResult> {
  const log = deps.logger ?? defaultLog;
  const admission = deps.stores.runs.begin(request.caseId, requestFingerprint(request));

  if (admission.kind === "replay") {
    log.info("request-level idempotency hit; nothing re-executed", { case_id: request.caseId });
    return toResult(admission.snapshot, deps, true);
  }
  if (admission.kind === "resumed") {
    // 接管重跑必须留痕：否则"为什么这个案件跑了两次"在事后完全查不出来。
    log.warn("resuming a case run that did not finish", {
      case_id: request.caseId,
      previous_error: admission.previousError,
    });
  }

  try {
    const snapshot = await execute(request, deps, log);
    deps.stores.runs.succeed(request.caseId, snapshot);
    return toResult(snapshot, deps, false);
  } catch (err: unknown) {
    // 失败要留痕再原样抛出：吞掉就成了"看着成功其实没跑完"。
    // 过 redactSecrets 是因为这条消息会落库。
    deps.stores.runs.fail(request.caseId, redactSecrets(errorMessage(err)));
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** 把快照与库里的账本行拼成对外结果。 */
function toResult<TReport extends VerificationReportView>(
  snapshot: CaseRunSnapshot,
  deps: RunCaseDeps<TReport>,
  replayed: boolean,
): CaseResult {
  return {
    caseId: snapshot.caseId,
    jobId: BigInt(snapshot.jobId),
    routing: snapshot.routing,
    sa: snapshot.sa,
    saHash: snapshot.saHash,
    adjudication: snapshot.adjudication,
    verification: snapshot.verification,
    settlement: snapshot.settlement,
    procurement: snapshot.procurement,
    briefingPack: snapshot.briefingPack,
    // 账本从库里读，不从快照读：同一份数据存两处早晚对不上。
    ledger: deps.stores.ledger.list(snapshot.caseId),
    replayed,
  };
}

/** 开案：createJob → setBudget → fund，全部经 `tx_log` 幂等（重发不重复上链）。 */
async function openJob<TReport extends VerificationReportView>(
  request: CaseRequest,
  deps: RunCaseDeps<TReport>,
): Promise<{ readonly jobId: bigint; readonly expiresAt: bigint }> {
  const { jobId } = await deps.jobClient.createJob({
    provider: request.job.provider,
    evaluator: request.job.evaluator,
    expiredAt: request.job.expiredAt,
    description: request.job.description ?? `Citely Deal Desk case ${request.caseId}`,
    caseId: request.caseId,
  });
  deps.stores.cases.setJobId(request.caseId, jobId);
  await deps.jobClient.setBudget(jobId, request.job.budgetAtomic);
  await deps.jobClient.fund(jobId, request.job.budgetAtomic);
  // 有效期从**链上回读**：本地那个值是"准备发出去的"，链上那个才是唯一真相，
  // 而它进 `deliverableHash`——`sa_hash` 的可复算性依赖这一点。
  const job = await deps.jobClient.getJob(jobId);
  return { jobId, expiresAt: job.expiredAt };
}

/** 出口 4 的升级材料；不是出口 4 就返回 `null`。 */
function escalationFor(
  request: CaseRequest,
  decision: ExitDecision,
  adjudicated: readonly AdjudicatedItem[],
  purchase: PurchaseRecord,
  facts: ReturnType<typeof intake>,
): ReturnType<typeof buildCaseEscalation> | null {
  if (decision.exit !== "interpretive_gray") return null;
  const itemIds = itemsNeedingEscalation({
    intake: "ok",
    expired: false,
    adjudications: toRoutingSummaries(adjudicated, true),
  }).map((item) => item.item_id);
  if (request.escalation === undefined) {
    throw new EscalationConfigMissingError(request.caseId, itemIds);
  }
  return buildCaseEscalation({
    caseId: request.caseId,
    rubric: request.rubric,
    moduleResponse: purchase.response,
    facts,
    items: adjudicated,
    escalatedItemIds: itemIds,
    config: request.escalation,
  });
}

/** 账本：complete 才有案件费拆分；采购行只要有回执就记。 */
function recordLedger<TReport extends VerificationReportView>(
  request: CaseRequest,
  deps: RunCaseDeps<TReport>,
  params: {
    readonly jobId: bigint;
    readonly action: SettlementActionView;
    readonly fees: JobFeeRates;
    readonly purchase: PurchaseRecord;
  },
): void {
  const entries = [
    // reject 路径下 escrow 退回 client，链上不产生我方收入；退款行需要
    // `Refunded` 事件里的实退金额，编排读不到就**不记**，绝不编一个数字。
    ...(params.action.action === "complete"
      ? completeLedger({
          caseId: request.caseId,
          jobId: params.jobId,
          budget: request.job.budgetAtomic,
          fees: params.fees,
        })
      : []),
    ...procurementLedger({
      caseId: request.caseId,
      quoted: request.module.quotedPriceAtomic,
      paid: params.purchase.paidAtomic,
      gatewayReceipt: params.purchase.settlementId,
      maintainerWallet: params.purchase.response.maintainer_wallet,
      royaltyBps: params.purchase.response.royalty_bps,
    }),
  ];
  recordLedgerIdempotent(deps.stores.ledger, entries);
}

/** {@link adjudicateAndSign} 的中间产物。 */
interface SignedCase {
  readonly adjudicated: readonly AdjudicatedItem[];
  readonly decision: ExitDecision;
  readonly escalation: ReturnType<typeof buildCaseEscalation> | null;
  readonly sa: Awaited<ReturnType<typeof assembleSa>>;
}

/**
 * 判定 → 五出口路由 →（出口 4）升级材料 → Policy Engine → 签名 SA。
 *
 * 这一段单独成函数是因为它是**纯业务**的一整块：除了签名之外不产生任何副作用，
 * 也不碰状态机以外的持久化。上链动作留在 `execute` 里，一眼能数清有几笔。
 */
async function adjudicateAndSign<TReport extends VerificationReportView>(
  request: CaseRequest,
  deps: RunCaseDeps<TReport>,
  ctx: {
    readonly facts: ReturnType<typeof intake>;
    readonly purchase: PurchaseRecord;
    readonly jobId: bigint;
    readonly expiresAt: bigint;
  },
): Promise<SignedCase> {
  // verdict 只进 basis[] 与 confidence（不变量 2）。
  const adjudicated = await adjudicateRubric({
    caseId: request.caseId,
    rubric: request.rubric,
    facts: ctx.facts,
    deps: deps.adjudicator,
  });

  const decision = routeExit({
    intake: "ok",
    expired: false,
    adjudications: toRoutingSummaries(adjudicated, true),
  });
  const escalation = escalationFor(request, decision, adjudicated, ctx.purchase, ctx.facts);
  const legs = buildSettlementLegs({
    party: request.settlement.party,
    payee: request.settlement.payee,
    amountAtomic: request.settlement.amountAtomic,
    moduleResponse: ctx.purchase.response,
    rubric: request.rubric,
    verdicts: toItemVerdicts(adjudicated),
    ...(escalation === null ? {} : { escalation: escalation.escalation }),
  });
  advanceCaseState(deps.stores.cases, request.caseId, "conditions_ready");

  const sa = await assembleSa({
    caseId: request.caseId,
    jobId: ctx.jobId,
    expiresAt: ctx.expiresAt,
    moduleResponse: ctx.purchase.response,
    legs,
    itemsCovered: request.rubric.rubric.items.length,
    operatorAccount: deps.operatorAccount,
    chainId: request.chainId,
    ...(deps.clock === undefined ? {} : { signedAt: deps.clock() }),
  });
  return { adjudicated, decision, escalation, sa };
}

async function execute<TReport extends VerificationReportView>(
  request: CaseRequest,
  deps: RunCaseDeps<TReport>,
  log: Logger,
): Promise<CaseRunSnapshot> {
  const { cases } = deps.stores;
  // ① intake：材料过沙箱（不变量 5）
  const facts = intake(request.deal);
  cases.ensureCase(request.caseId);

  const intakeStatus = deriveIntakeStatus(facts, request.rubric);
  if (intakeStatus !== "ok") {
    // 出口 1。服务侧我们**同时是建 Job 的一方**：材料根本读不了时不该先建 Job
    // 再让验证器 reject——没有 escrow 就没有要 reject 的东西，也不该花这笔 gas。
    throw new IntakeRejectedError(
      request.caseId,
      routeExit({ intake: intakeStatus, expired: false, adjudications: [] }),
    );
  }

  // ② 8183 开案
  const { jobId, expiresAt } = await openJob(request, deps);
  advanceCaseState(cases, request.caseId, "decomposed");

  // ③ x402 采购（案件级幂等：重发不重复付款）
  const { record: purchase, reused } = await procureOnce({
    store: deps.stores.purchases,
    x402: deps.x402,
    caseId: request.caseId,
    moduleId: request.module.id,
    dealInput: request.deal,
  });
  advanceCaseState(cases, request.caseId, "assessing");
  log.info("module result acquired", {
    case_id: request.caseId,
    module: purchase.response.module,
    reused_purchase: reused,
  });

  // ④⑤⑥ 判定 → 路由 → Policy Engine → SA
  const { adjudicated, decision, escalation, sa } = await adjudicateAndSign(request, deps, {
    facts,
    purchase,
    jobId,
    expiresAt,
  });
  await deps.jobClient.submit(jobId, sa.attestation.sa_hash);
  advanceCaseState(cases, request.caseId, "submitted");

  // ⑦ 三检 + 收口（都由调用方注入：验证器是独立进程、独立密钥）
  const report = await deps.verify({
    sa,
    rubric: request.rubric,
    submittedDeliverableHash: sa.attestation.sa_hash,
    chainId: request.chainId,
  });
  const action = await deps.settle({ jobId, report });

  // ⑧ 账本 + 链上状态对账
  recordLedger(request, deps, {
    jobId,
    action,
    fees: await deps.jobClient.getFeeRates(),
    purchase,
  });
  cases.reconcileJobState(request.caseId, await deps.jobClient.getJobState(jobId));

  return {
    caseId: request.caseId,
    jobId: jobId.toString(),
    routing: {
      exit: decision.exit,
      chainAction: decision.chainAction,
      actor: decision.actor,
      reason: decision.reason,
    },
    sa,
    saHash: sa.attestation.sa_hash,
    adjudication: adjudicated,
    verification: { passed: report.passed, reasonHash: report.reasonHash, outcomes: report.outcomes },
    settlement: action,
    procurement: {
      settlementId: purchase.settlementId,
      paidAtomic: usdc6ToAtomicString(purchase.paidAtomic),
      reused,
    },
    briefingPack: escalation === null ? null : escalation.briefingPack,
  };
}
