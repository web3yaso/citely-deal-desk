/**
 * 编排的各个阶段（纯函数为主，便于单测）。
 *
 * 阶段划分照合约：intake → 8183 → 判定 → 出口路由 →（必要时）x402 采购 →
 * Policy Engine → SA 生成与签名 → 账本。`run-case.ts` 只负责把它们串起来
 * 并处理幂等与副作用，业务逻辑都在这里。
 *
 * **不变量 2 在本文件的落法**：{@link buildSettlementLegs} 把 `moduleResponse`
 * 交给 Policy Engine 的 `buildLegs` 推 `condition`，判定器的 verdict 只进
 * `basis[]` 与 `confidence`——这两条路径在 engine 的类型签名上就是分开的。
 */

import type { JobFeeRates, ModuleResponse } from "@citely/chain/types";
import type { Address } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { AdjudicatedItem, ItemVerdicts } from "../adjudicator/rubric-run.js";
import type { CaseState } from "../db/state.js";
import type { CaseStore } from "../db/store.js";
import { buildEscalation } from "../escalation/index.js";
import type { BriefingItem } from "../escalation/briefing.js";
import { entriesForComplete, entryForModuleFee, entryForRoyalty } from "../ledger/entries.js";
import type { LedgerEntry } from "../ledger/types.js";
import { DuplicateLedgerEntryError, LedgerStore } from "../ledger/store.js";
import { buildLegs } from "../policy/legs.js";
import type { AdjudicationSummary, IntakeStatus } from "../routing/exits.js";
import type { LoadedRubric } from "../rubric/types.js";
import { buildSettlementAuthorization } from "../sa/build.js";
import type { SaEscalation, SaLeg, SaModuleUsed, SettlementAuthorization } from "../sa/types.js";
import { sanitizeMaterial } from "../sandbox/index.js";
import type { SanitizedFacts } from "../sandbox/types.js";
import { usdc6 } from "../util/usdc6.js";
import type { Usdc6 } from "../util/usdc6.js";
import type { EscalationConfig } from "./types.js";

/**
 * intake：把案件材料过沙箱。
 *
 * 不变量 5：材料是数据不是指令。沙箱输出是材料能到达判定器的唯一形态。
 *
 * @param deal - 案件输入
 * @returns 结构化事实（含确定性注入检测结果）
 */
export function intake(deal: {
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly activity: unknown;
}): SanitizedFacts {
  return sanitizeMaterial({ fields: { ...deal.evidence, activity: deal.activity } });
}

/**
 * 受理结论（出口 1 的判据）。
 *
 * 只做**确定性**判断，不问 LLM：
 * - 沙箱一个字段都没解析出来 → `unparsable`（材料根本读不了）；
 * - rubric 没有判定项 → `out_of_rubric_scope`（这份材料落在 rubric 覆盖范围外）。
 *
 * @param facts - 沙箱输出
 * @param rubric - 本案使用的 rubric
 */
export function deriveIntakeStatus(facts: SanitizedFacts, rubric: LoadedRubric): IntakeStatus {
  if (Object.keys(facts.fields).length === 0) return "unparsable";
  if (rubric.rubric.items.length === 0) return "out_of_rubric_scope";
  return "ok";
}

/**
 * 判定结果 → 路由摘要。
 *
 * `procurementExhausted` 取"本案是否已经采购过"：编排在判定**之前**就买了
 * Module 结果（`condition` 的推导需要它），所以判定完还剩的数据缺口就是
 * "买过仍未消解"的那一类，按 `routing/exits.ts` 的定义该走出口 4 而不是再买一轮。
 *
 * @param items - 判定结果
 * @param procured - 本案是否已完成过采购
 */
export function toRoutingSummaries(
  items: readonly AdjudicatedItem[],
  procured: boolean,
): readonly AdjudicationSummary[] {
  return items.map((item) => ({
    item_id: item.item_id,
    verdict: item.verdict,
    ...(item.gray_type === undefined ? {} : { gray_type: item.gray_type }),
    procurementExhausted: procured,
  }));
}

/** {@link buildSettlementLegs} 的参数。 */
export interface BuildLegsParams {
  readonly party: string;
  readonly payee: Address;
  readonly amountAtomic: Usdc6;
  readonly moduleResponse: ModuleResponse;
  readonly rubric: LoadedRubric;
  readonly verdicts: ItemVerdicts;
  /** 出口 4 的升级材料；其余出口不传。 */
  readonly escalation?: SaEscalation;
}

/**
 * 组装 SA 的 `legs[]`。
 *
 * @param params - 收款方、金额、Module 结果、rubric 与各判定项 verdict
 * @returns SA 的 legs
 * @throws {Error} 有 rubric 判定项没有对应 verdict——缺项组不出合规 SA，提前响亮失败
 */
export function buildSettlementLegs(params: BuildLegsParams): readonly SaLeg[] {
  const basis = params.rubric.rubric.items.map((item) => {
    const verdict = params.verdicts[item.id];
    if (verdict === undefined) {
      throw new Error(`missing adjudication verdict for rubric item ${item.id}`);
    }
    return { item_id: item.id, verdict, source: item.source };
  });

  return buildLegs([
    {
      party: params.party,
      payee: params.payee,
      amount_nominal: params.amountAtomic,
      modules: [
        {
          overall: params.moduleResponse.overall,
          settlement_constraints: params.moduleResponse.settlement_constraints,
        },
      ],
      basis,
      ...(params.escalation === undefined ? {} : { escalation: params.escalation }),
    },
  ]);
}

/** {@link buildCaseEscalation} 的参数。 */
export interface BuildCaseEscalationParams {
  readonly caseId: string;
  readonly rubric: LoadedRubric;
  readonly moduleResponse: ModuleResponse;
  readonly facts: SanitizedFacts;
  readonly items: readonly AdjudicatedItem[];
  /** 需要人工复核的判定项 id（来自 `itemsNeedingEscalation`）。 */
  readonly escalatedItemIds: readonly string[];
  readonly config: EscalationConfig;
}

/**
 * 出口 4：组装升级材料（卷宗 + Review Job 模板）。
 *
 * 卷宗里的每个字段都来自确定性数据（rubric 原文 + 判定器 verdict + Module 版本），
 * `narrative` 留空——LLM 起草是后续能力，这里宁可给模板化最小版也不编。
 *
 * @returns 挂到 ESCALATE 腿上的 `escalation` 对象与要落盘的卷宗正文
 */
export function buildCaseEscalation(params: BuildCaseEscalationParams): ReturnType<typeof buildEscalation> {
  const byId = new Map(params.items.map((item) => [item.item_id, item]));
  const briefingItems: BriefingItem[] = [];
  for (const rubricItem of params.rubric.rubric.items) {
    if (!params.escalatedItemIds.includes(rubricItem.id)) continue;
    const adjudicated = byId.get(rubricItem.id);
    if (adjudicated === undefined) {
      throw new Error(`escalated item ${rubricItem.id} has no adjudication result`);
    }
    briefingItems.push({
      item_id: rubricItem.id,
      question: rubricItem.question,
      source: rubricItem.source,
      verdict: adjudicated.verdict,
      gray_type: "interpretive",
      confidence_rule: rubricItem.confidence_rule,
    });
  }

  return buildEscalation({
    briefing: {
      caseId: params.caseId,
      rubricId: params.rubric.id,
      rubricVersion: params.rubric.rubric.version,
      modulesUsed: [
        {
          module_id: params.moduleResponse.module,
          version: params.moduleResponse.version,
          evidence_hash: params.moduleResponse.evidence_hash,
        },
      ],
      items: briefingItems,
      materialSha256: params.facts.material_sha256,
    },
    reviewJob: {
      client: params.config.client,
      provider: params.config.provider,
      evaluator: params.config.evaluator,
      expiresAt: params.config.expiresAt,
      deposit: params.config.deposit,
      escalatedItemIds: params.escalatedItemIds,
    },
  });
}

/** {@link assembleSa} 的参数。 */
export interface AssembleSaParams {
  readonly caseId: string;
  readonly jobId: bigint;
  /**
   * SA 有效期，取**链上 Job 的 `expiredAt`**（Unix 秒）。
   *
   * 刻意不是 `Date`：`expires_at` 在 `deliverableHash` 的输入里，只要它带一丝
   * 墙上时钟，"同样输入 → 同样 SA"就不成立。链上那个值 createJob 之后固定不变。
   */
  readonly expiresAt: bigint;
  readonly moduleResponse: ModuleResponse;
  readonly legs: readonly SaLeg[];
  readonly itemsCovered: number;
  /** 由 `OPERATOR_PRIVATE_KEY` 派生（合约 §5.1：SA 的签名者是运营密钥）。 */
  readonly operatorAccount: LocalAccount;
  readonly chainId: number;
  /** 只进 `attestation.signed_at`，**不进 `sa_hash`**。 */
  readonly signedAt?: Date;
}

/**
 * 组装并由运营密钥签名 SA。
 *
 * @param params - 绑定信息、Module 版本、腿与签名账户
 * @returns 完整 SA
 */
export async function assembleSa(params: AssembleSaParams): Promise<SettlementAuthorization> {
  const modulesUsed: readonly SaModuleUsed[] = [
    {
      module_id: params.moduleResponse.module,
      version: params.moduleResponse.version,
      evidence_hash: `0x${params.moduleResponse.evidence_hash}`,
    },
  ];
  return await buildSettlementAuthorization({
    caseId: params.caseId,
    jobId: params.jobId,
    expiresAt: params.expiresAt,
    modulesUsed,
    legs: params.legs,
    itemsCovered: params.itemsCovered,
    account: params.operatorAccount,
    chainId: params.chainId,
    ...(params.signedAt === undefined ? {} : { signedAt: params.signedAt }),
  });
}

/** 零地址 = 该实例未配置版税收款方（docs/api.md），**不得**向它转账。 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** {@link procurementLedger} 的参数。 */
export interface ProcurementLedgerParams {
  readonly caseId: string;
  /** x402 报价金额（模块定价）。 */
  readonly quoted: Usdc6;
  /** 实付金额（余额差实测）。 */
  readonly paid: Usdc6;
  /** Gateway 回执 ID。**没有它就不产生任何行**。 */
  readonly gatewayReceipt: string;
  readonly maintainerWallet: string;
  readonly royaltyBps: number;
}

/**
 * 采购相关的账本条目：`module_fee`，以及**仅在确有版税时**的 `royalty`。
 *
 * `ref_type` 恒为 `gateway_receipt`——x402 是链下授权，批量结算前没有 txHash
 * （v2.3 §3.5）。`maintainer_wallet` 为零地址或 `royalty_bps === 0` 时不产生
 * `royalty` 行（docs/api.md：零地址表示无版税应付）。
 */
export function procurementLedger(params: ProcurementLedgerParams): readonly LedgerEntry[] {
  const entries: LedgerEntry[] = [
    entryForModuleFee({
      caseId: params.caseId,
      quoted: params.quoted,
      paid: params.paid,
      gatewayReceipt: params.gatewayReceipt,
    }),
  ];

  const hasRoyalty = params.royaltyBps > 0 && params.maintainerWallet.toLowerCase() !== ZERO_ADDRESS;
  if (hasRoyalty) {
    // 版税 = 本次采购价 × bps / 10000，整数除法（不四舍五入，少算不多算）。
    const amount = usdc6((params.paid * BigInt(params.royaltyBps)) / 10_000n);
    entries.push(entryForRoyalty({ caseId: params.caseId, amount, gatewayReceipt: params.gatewayReceipt }));
  }
  return entries;
}

/** {@link completeLedger} 的参数。 */
export interface CompleteLedgerParams {
  readonly caseId: string;
  readonly jobId: bigint;
  readonly budget: Usdc6;
  /** **链上读回的**费率。严禁硬编码（合约 §2.4）。 */
  readonly fees: JobFeeRates;
}

/**
 * 产出 `complete` 的账本条目。
 *
 * 直接转调 `entriesForComplete`（账本的唯一实现）——编排不自己再算一遍净额，
 * 两套算法对上了也证明不了账本是对的。
 */
export function completeLedger(params: CompleteLedgerParams): readonly LedgerEntry[] {
  return entriesForComplete({
    caseId: params.caseId,
    jobId: params.jobId,
    budget: params.budget,
    fees: params.fees,
  });
}

/** 入账结果：这次真写进去几行、因幂等被挡下几行。 */
export interface LedgerWriteResult {
  readonly inserted: number;
  readonly skipped: number;
}

/**
 * 幂等入账：逐行写，重复的**被挡下并计数**，不让整批失败。
 *
 * 为什么不用 `recordAll`：它是事务性的，任意一行重复就整批回滚——那对"首次写入"
 * 是对的，但对"重试"是错的：重试时全部行都该被挡下，而我们要的是"确认它们被挡下了"，
 * 不是抛异常中止请求。
 */
export function recordLedgerIdempotent(
  ledger: LedgerStore,
  entries: readonly LedgerEntry[],
): LedgerWriteResult {
  let inserted = 0;
  let skipped = 0;
  for (const entry of entries) {
    try {
      ledger.record(entry);
      inserted += 1;
    } catch (err: unknown) {
      // 这正是幂等生效的证据：同一笔收支不会被记第二遍。
      if (!(err instanceof DuplicateLedgerEntryError)) throw err;
      skipped += 1;
    }
  }
  return { inserted, skipped };
}

/** 案件状态的推进顺序（终局态并列在最后）。 */
const CASE_STATE_ORDER: readonly CaseState[] = [
  "intake",
  "decomposed",
  "assessing",
  "conditions_ready",
  "submitted",
];

/**
 * 单调推进案件状态：**已经到达或越过目标态就跳过**。
 *
 * 为什么需要它：请求重试会让同一个案件从头再跑一遍编排，而 `transitionCase`
 * 对 `assessing → decomposed` 这种回退是抛错的（这是对的，状态机不该被写坏）。
 * 编排要的是"确保至少到了这一步"，不是"从上一步跃迁过来"。
 *
 * 终局态（settled/rejected）不走这里——它们必须带出口原因，由调用方显式跃迁。
 *
 * @returns 是否真的发生了跃迁
 */
export function advanceCaseState(cases: CaseStore, caseId: string, to: CaseState): boolean {
  const current = cases.getCase(caseId).state;
  const currentIndex = CASE_STATE_ORDER.indexOf(current);
  const targetIndex = CASE_STATE_ORDER.indexOf(to);
  if (targetIndex < 0) throw new Error(`advanceCaseState does not handle terminal state: ${to}`);
  // 当前已是终局态（不在推进序列里）时不动它——终局就是终局。
  if (currentIndex < 0 || currentIndex >= targetIndex) return false;

  // 逐级推进，保证每一步都过跃迁表的校验（不许跳级绕过状态机）。
  for (let i = currentIndex + 1; i <= targetIndex; i += 1) {
    const next = CASE_STATE_ORDER[i];
    if (next === undefined) throw new Error("case state order is inconsistent");
    cases.transitionCase(caseId, next);
  }
  return true;
}
