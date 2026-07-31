/**
 * 纵切端到端演示：intake → 8183 → 判定 → x402 → SA → 三检 → complete。
 *
 * ```
 * node --import tsx demo/run-vertical-slice.ts --dry-run   # 不发交易、不付费
 * node --import tsx demo/run-vertical-slice.ts             # 真实 testnet
 * ```
 *
 * ## 编排只有一条：`runCase()`
 *
 * 本脚本**不自己编排**，它调 `@citely/engine/orchestrator` 的 `runCase()`——
 * 与 HTTP 服务走的是同一条主线，差别只在注入的实现（dry-run 注入替身，
 * 真实模式注入 chain 的真客户端）。这样演示就成了服务的回归测试：
 * 两边共用一条路径，一边的 bug 另一边跑得到。
 *
 * 从前这里有第二套编排（自己按顺序调 intake / 开案 / 采购 / 判定 / 签 SA / 三检），
 * 与 engine 那套并存。并存的代价是"改一处不改另一处"——演示对而服务错，
 * 或者反过来，而且两边的 bug 互不暴露。
 *
 * ## 硬纪律
 *
 * - **任何一步失败都响亮报错中止**，不许静默降级。真实模式缺密钥/缺地址即退出，
 *   绝不自动退回 dry-run；
 * - **不打印密钥**，所有错误过 `redactSecrets` 再出；
 * - 金额**照实显示**：`complete` 会扣 platformFee + evalFee（合约 §2.4），
 *   但费率是链上变量，当前部署可能就是 0。**`--dry-run` 也真读链上费率**
 *   （`platformFeeBP()` 是 view，只读不花钱）；
 * - 打印的金额全部来自 **engine 的账本条目**（`result.ledger`），
 *   演示脚本不自己算一遍净额——两套算法对上了也证明不了账本是对的；
 * - SA 是"条件证明，由钱包按自有预设策略核验执行"，不是 Citely 授权付款。
 *
 * 免责声明：输出为基于公开法源整理的检查项状态，不构成法律意见。
 */

import { loadDotEnvFile } from "@citely/chain";
import { redactSecrets, registerSecret, safeErrorMessage } from "@citely/chain";
import type { JobClient, ModuleId, ModuleResponse } from "@citely/chain";
import { createLogger, findRepoRoot, formatUsdc6, usdc6 } from "@citely/engine";
import {
  createAdjudicatorLLM,
  FileGoldenCache,
  parseAdjudicatorMode,
} from "@citely/engine/adjudicator";
import type { AdjudicatedItem } from "@citely/engine/adjudicator";
import { CaseStore, LedgerStore } from "@citely/engine";
import type { LedgerEntry } from "@citely/engine/ledger";
import {
  CaseRunStore,
  intake,
  PurchaseStore,
  runCase,
} from "@citely/engine/orchestrator";
import type { CaseResult, RunCaseDeps } from "@citely/engine/orchestrator";
import { buildCaseDescription, MarketplaceAgent, PAYOUT_RULE_SUMMARY } from "@citely/marketplace";
import type { SettlementDecision, SettlementRun, WalletSettlementPolicy } from "@citely/marketplace";
import { settleVerifiedJob, verifySettlementAuthorization } from "@citely/verifier";
import type { VerificationReport } from "@citely/verifier";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import {
  assertRoyaltyRenderable,
  CLEAN_DEAL_INPUT,
  loadDemoRubric,
  loadModuleResponse,
} from "./fixtures/index.js";
import type { FixtureProvenance } from "./fixtures/index.js";
import { deriveAddresses, resolveSliceConfig } from "./slice/config.js";
import type { SliceConfig } from "./slice/config.js";
import { createDryRunPaymentExecutor, createDryRunX402Client } from "./slice/doubles.js";
import { buildJobClient } from "./slice/job-client.js";
import { openSlicePersistence } from "./slice/persistence.js";
import { resolveFeeRates } from "./slice/fees.js";
import { loadRepoTrust, prepareEphemeralTrust, repoTrustPresent } from "./slice/trust.js";

const log = createLogger("slice");

/** 案件费（名义）。`usdc6()` 是 engine 的构造器——金额是分支类型，不许裸 bigint 冒充。 */
const CASE_FEE_ATOMIC = usdc6(3_000_000n);
/** 客户付给收款方的金额。 */
const PAYOUT_ATOMIC = usdc6(12_500_000n);
/** us-msb 的 x402 报价（合约 §1 定价表）。 */
const MODULE_PRICE_ATOMIC = usdc6(800_000n);
/** 演示收款方——**不是**任何 Citely 地址（不变量 3）。 */
const PAYEE: Address = "0x000000000000000000000000000000000000BEEF";
/** 本案唯一一条结算腿的标识。进 SA 的 `legs[].party`。 */
const PARTY = "payee";
/** 本案采购的 Module。 */
const MODULE_ID: ModuleId = "us-msb";

/**
 * 案件 Job 的 `expiredAt`（Unix 秒）——**写死，不用 `Date.now()`**。
 *
 * 它经 `createJob` 上链，再被回读进 SA 的 `bound_to.expires_at`，而后者在
 * `deliverableHash` 的输入里。取墙上时钟的话每跑一次就换一个 `sa_hash`，
 * "同样输入 → 同样 SA"这条对外承诺当场失效（2026-07-29/30 两次事故的共同根因）。
 */
const CASE_EXPIRES_AT_UNIX = BigInt(Math.floor(Date.parse("2026-12-31T00:00:00.000Z") / 1000));

/**
 * 出口 4 的 Review Job 截止时刻——**同样写死**。
 *
 * 它经 Review Job 模板进 `escalation`，而 `escalation` 挂在 SA 的腿上、
 * 进 `sa_hash`。取墙上时钟就会让 `sa_hash` 每跑一变，与上面那条同一个道理。
 */
const REVIEW_EXPIRES_AT = new Date("2027-01-15T00:00:00.000Z");

/** 出口 4 的 Review 保证金。 */
const REVIEW_DEPOSIT_ATOMIC = usdc6(5_000_000n);

/**
 * 打印一行。
 *
 * 用 chain 的**登记表式**遮蔽（只替换真正登记过的密钥），不是模式匹配式的——
 * 后者会把 `0x` + 64 hex 一律打成 `[REDACTED]`，而 `sa_hash` / `reasonHash` / txHash
 * 正好是这个形状，演示就没法跟链上核对了。密钥在 `main()` 开头统一登记。
 *
 * @param line - 要输出的一行文本
 */
function say(line: string): void {
  process.stdout.write(`${redactSecrets(line)}\n`);
}

/**
 * 打印判定结果分布与**数据来源**。
 *
 * 来源（live / cache）必须显式打印：整个 golden cache 的价值就是"离线可复现"，
 * 而"这次到底是真调了 API 还是命中了缓存"是评委会问的第一个问题。
 * 混着不说，等于把 L1 承诺讲成一句无法核对的话。
 */
function reportAdjudication(items: readonly AdjudicatedItem[], mode: string): void {
  const dist = new Map<string, number>();
  for (const i of items) dist.set(i.verdict, (dist.get(i.verdict) ?? 0) + 1);
  const hits = items.filter((i) => i.cacheHit).length;
  const fallbacks = items.filter((i) => i.repairs.some((r) => r.startsWith("fallback:")));
  const flags = [...new Set(items.flatMap((i) => i.risk_flags))].sort();

  say(
    `  · 判定器：${items.length} 项 mode=${mode} ` +
      `来源=${hits === items.length ? "全部命中 golden（离线可复现）" : hits === 0 ? "全部 live 调用" : `${String(hits)}/${String(items.length)} 命中 golden`}`,
  );
  say(`  · verdict 分布：${[...dist].map(([v, n]) => `${v}×${String(n)}`).join(" ")}`);
  for (const i of items) {
    say(
      `      ${i.item_id} → ${i.verdict}${i.gray_type === undefined ? "" : `/${i.gray_type}`}` +
        ` conf=${i.confidence}${i.risk_flags.length === 0 ? "" : ` flags=[${i.risk_flags.join(",")}]`}` +
        `${i.repairs.length === 0 ? "" : ` repairs=[${i.repairs.join(",")}]`}` +
        ` ${i.cacheHit ? "(cache)" : "(live)"}`,
    );
  }
  if (flags.length > 0) say(`  · 风险标记合集：${flags.join(", ")}`);
  if (fallbacks.length > 0) {
    // 降级要响亮：兜底不是"跑通了"，必须让人一眼看见。
    say(
      `  ⚠️ ${String(fallbacks.length)} 项判定降级为 unverifiable（判定器不可用）——` +
        `兜底结果不写 golden cache，且 condition 不受影响（不变量 2）`,
    );
  }
}

/** 案件费拆分：**全部从账本条目读回**，演示不自己再算一遍净额。 */
interface FeeSplitView {
  readonly budget: bigint;
  readonly net: bigint;
  readonly evaluatorFee: bigint;
  readonly platformFee: bigint;
}

/**
 * 从账本条目还原案件费拆分。
 *
 * 之所以是"还原"而不是"计算"：`entriesForComplete` 是净额的唯一实现，
 * 演示再算一遍只会得到两套算法，对上了也证明不了账本是对的。
 * platformFee 用减法反推——它没有单独的账本行（它进的是平台方，不是我们的账）。
 *
 * @param entries - 本案件的全部账本行
 * @returns 拆分视图；没有 case_fee 行时返回 `null`
 */
function feeSplitFromLedger(entries: readonly LedgerEntry[]): FeeSplitView | null {
  const caseFees = entries.filter((e) => e.category === "case_fee");
  const operator = caseFees.find((e) => e.account === "operator");
  const evaluator = caseFees.find((e) => e.account === "verifier");
  if (operator === undefined || evaluator === undefined) return null;
  const budget = operator.amount_nominal;
  const net = operator.amount_actual;
  const evaluatorFee = evaluator.amount_actual;
  return { budget, net, evaluatorFee, platformFee: budget - net - evaluatorFee };
}

/**
 * 解释 `net` 与 `budget` 的关系。
 *
 * **只有费率真的来自链上时才敢说"当前部署费率为 0"**——占位值也是 0，
 * 拿占位值去断言链上部署的费率，就是把一句猜测说成实测。
 *
 * @param split - 账本还原出的金额拆分
 * @param feeFromChain - 费率是否真的来自链上
 * @returns 附在金额后面的说明
 */
function explainNet(split: FeeSplitView, feeFromChain: boolean): string {
  if (!feeFromChain) return "（⚠️ 费率为占位值，此处金额不可用于对账）";
  if (split.net === split.budget) return "（链上实测费率为 0，故 net 等于 budget）";
  return "（net 小于 budget，合约 §2.4 的两道手续费）";
}

/**
 * 渲染一行账本（v2.3 §3.5 的 `ref_type` 三态）。
 *
 * 三态不是形式主义：x402 采购是**链下授权**，Gateway 把大量授权打包成单笔链上结算，
 * 所以 `module_fee` 发生的那一刻**只有回执、没有 txHash**。强行填 txHash
 * 只能填空值或假值——假 txHash 是评委一点就穿的东西。
 *
 * @param entry - 账本条目
 * @returns 可直接打印的一行
 */
function formatLedgerRow(entry: LedgerEntry): string {
  const refLabel: Record<LedgerEntry["ref_type"], string> = {
    jobId: "job",
    gateway_receipt: "回执",
    txHash: "tx",
  };
  const settlement =
    entry.ref_type === "gateway_receipt"
      ? `  结算tx=${entry.settlement_tx ?? "待结算（Gateway 批量结算尚未发生）"}`
      : "";
  return (
    `${entry.account}: ${entry.direction} ${entry.category} ` +
    `nominal=${formatUsdc6(entry.amount_nominal)} actual=${formatUsdc6(entry.amount_actual)} ` +
    `${refLabel[entry.ref_type]}=${entry.ref}${settlement}`
  );
}

/**
 * 打印账本行。
 *
 * 版税行有一道闸：`maintainer_wallet` / `royalty_bps` 未经真实录制时**不渲染**
 * （`assertRoyaltyRenderable`）。注意这只挡"渲染"，不挡"入账"——账本里记的是
 * engine 从真实采购响应算出来的东西，是否**拿给人看**才由 fixture 来源决定。
 *
 * @param entries - 本案件全部账本行
 * @param provenance - Module 响应的来源标注；真实模式为 `null`
 */
function reportLedger(
  entries: readonly LedgerEntry[],
  provenance: FixtureProvenance | null,
): void {
  let royaltyRenderable = true;
  if (provenance !== null) {
    try {
      assertRoyaltyRenderable(provenance);
    } catch {
      royaltyRenderable = false;
    }
  }

  for (const entry of entries) {
    if (entry.category === "royalty" && !royaltyRenderable) continue;
    say(`      账本 ${formatLedgerRow(entry)}`);
  }
  if (!royaltyRenderable) {
    say("      （版税行未渲染：版税字段未经真实录制，不拿合成数据充版税真值）");
  }
  const royalty = entries.find((e) => e.category === "royalty");
  if (royalty === undefined) {
    say("      （无版税行：按 docs/api.md，零地址或 0 bps 即无版税应付）");
  }
}

/**
 * 打印客户钱包的核验结论。
 *
 * **这是整个演示最关键的一刻**：系统决定付不付钱。所以不能只给一个布尔值——
 * 不付款时**理由必须当场可见**，否则看的人第一反应就是"那为什么没执行？"。
 *
 * 两个概念刻意分行呈现，不挤在一起（挤在一起才会出现
 * "execute=false 但 blockers=无"这种看着自相矛盾的输出）：
 * - **逐腿扣住**（withheld）：这条腿的条件没满足，如 `condition=HOLD`；
 * - **整单红线**（blockers）：这份 SA 整体不可信/越界，如出具方不认、收款方在黑名单。
 *   它为空是正常的，**不代表会付款**。
 *
 * @param run - 钱包核验与付款结果
 */
function reportWalletDecision(run: SettlementRun): void {
  const { decision } = run;
  say("\n客户钱包核验（钱包按**自有预设策略**独立判定；SA 是条件证明，不是 Citely 的付款指令）：");
  say(`  放款规则（钱包主人事先配置）：${PAYOUT_RULE_SUMMARY}`);

  if (decision.execute) {
    say(`  execute=true —— ${String(decision.payments.length)} 条腿满足放款条件`);
  } else {
    say(`  execute=false —— ${describeWhyNotExecuted(decision)}`);
  }

  // 逐腿说明：哪一条、什么 condition、被什么规则扣住。
  for (const leg of decision.withheld) {
    say(
      `  · leg[${String(leg.legIndex)}] party=${leg.party} ` +
        `condition=${leg.condition ?? "无法识别"} → 不可付（${leg.code}）`,
    );
  }
  for (const blocker of decision.blockers) {
    say(`  · 整单红线：${blocker.code}（${blocker.detail}）`);
  }

  const paid =
    decision.payments.map((p) => `${p.party}->${p.to}:${formatUsdc6(usdc6(p.amountAtomic))}`).join(", ") || "无";
  say(`  payments=${paid}`);
  say(
    `  整单红线 blockers=${decision.blockers.length === 0 ? "无" : String(decision.blockers.length)}` +
      "（红线为空只说明这份 SA 本身可信，不代表会付款——放款与否见上方逐腿说明）",
  );
  say("（付款目标恒为 SA 里的收款方，客户资金永不进 Citely 地址。）");
}

/**
 * 用一句话说清楚为什么没付款。
 *
 * @param decision - 钱包核验结论
 * @returns 面向人的原因说明
 */
function describeWhyNotExecuted(decision: SettlementDecision): string {
  if (decision.blockers.length > 0) {
    return `命中 ${String(decision.blockers.length)} 条整单红线，钱包一分钱都不付`;
  }
  if (decision.withheld.length > 0) {
    const codes = [...new Set(decision.withheld.map((w) => w.code))].join("、");
    return `${String(decision.withheld.length)} 条腿未满足放款条件（${codes}），无可放款的腿`;
  }
  return "SA 未包含任何结算腿";
}

/** 钱包主人预设的结算策略。演示里把 Citely 地址放进黑名单——不变量 3 由客户自己把关。 */
function walletPolicy(citelyAddresses: readonly Address[], issuer: Address): WalletSettlementPolicy {
  return {
    trustedIssuers: [issuer],
    neverPayTo: citelyAddresses,
    maxLegAmountAtomic: 50_000_000n,
    maxTotalAmountAtomic: 50_000_000n,
    requiredModuleRefs: [],
  };
}

/**
 * 建 x402 采购客户端。
 *
 * dry-run 用录制快照的替身（`--dry-run` 明确定义为不付费，而 check 是付费端点）；
 * 真实模式走**真实 msb-agent**。两条分支互斥，真实模式绝不回落到替身。
 *
 * 采购幂等（不变量 6「重试不重复付款」）现在由 engine 的 `purchases` 表承担，
 * 演示不再自己管一份缓存文件——同一案件的同一 Module 只买一次由编排保证。
 */
async function buildX402Client(config: SliceConfig): Promise<{
  readonly x402: RunCaseDeps<VerificationReport>["x402"];
  readonly provenance: FixtureProvenance | null;
}> {
  if (config.dryRun) {
    const { provenance, response } = loadModuleResponse();
    say(
      `  · Module 结果：${provenance.source === "recorded" ? "真实录制" : "⚠️ 合成替身"}` +
        `（${provenance.module}@${provenance.version}，${provenance.capturedAt}）——--dry-run 不付费`,
    );
    if (provenance.source !== "recorded") say(`    ${provenance.note}`);
    const { client } = createDryRunX402Client({
      response,
      settlementId: provenance.settlementId,
      paidAtomic: MODULE_PRICE_ATOMIC,
    });
    return { x402: client, provenance };
  }

  // 真实模式：按需加载。`createGatewayClient` 会连 Gateway，dry-run 下不该构造它。
  const { createGatewayClient, createX402Client } = await import("@citely/chain");
  say("  · Module 结果：真实模式，采购走 x402（首次会付费；重发同一案件由采购表挡住）");
  return {
    x402: createX402Client({
      baseUrl: config.msbAgentBaseUrl,
      gateway: createGatewayClient(config.keys.procurement, config.rpcUrl ?? undefined),
    }),
    provenance: null,
  };
}

/** 三检与收口端口：由**独立验证器**实现，用它自己的密钥发收口交易。 */
async function buildVerifierPorts(
  config: SliceConfig,
  jobClient: JobClient,
  operator: Address,
  moduleResponse: ModuleResponse,
): Promise<Pick<RunCaseDeps<VerificationReport>, "verify" | "settle">> {
  // 真实模式恒用仓库里的正式信任根，缺文件即中止（绝不回落）。
  // dry-run 在正式信任根尚未落地时用一次性排练信任根——但会打横幅说清楚，
  // 免得有人把"排练通过"当成"正式信任根验过了"。
  const useRehearsalTrust = config.dryRun && !repoTrustPresent();
  if (useRehearsalTrust) {
    say("⚠️  仓库尚无 attestations/registry.json + modules.json，本次用**一次性排练信任根**；");
    say("    这不代表正式信任根已通过验证。真实模式下缺这两份文件会直接中止。");
  }
  const trust = useRehearsalTrust
    ? await prepareEphemeralTrust({
        operator,
        // 第四把一次性密钥：Module 认证方与运营/验证器都不是同一个人。
        attester: privateKeyToAccount(generatePrivateKey()),
        modules: [{ moduleId: moduleResponse.module, version: moduleResponse.version }],
        rulesHash: `0x${moduleResponse.evidence_hash}`,
        chainId: config.chainId,
      })
    : loadRepoTrust();
  say(`  · 信任根：${trust.source}`);

  return {
    verify: async (request) =>
      await verifySettlementAuthorization({
        sa: request.sa,
        rubric: request.rubric.rubric,
        manifest: trust.manifest,
        registry: trust.registry,
        submittedDeliverableHash: request.submittedDeliverableHash,
        chainId: request.chainId,
      }),
    settle: async (request) => {
      const action = await settleVerifiedJob({
        jobClient,
        jobId: request.jobId,
        report: request.report,
      });
      // **只回端口声明的两个字段**。verifier 的 `SettlementAction` 还带一个
      // `jobId: bigint`，而编排会把这个返回值原样写进运行快照，快照要过
      // `JSON.stringify`——bigint 进去就直接抛 "Do not know how to serialize a BigInt"。
      // 结构化类型允许多带字段，所以编译期发现不了，只有真跑才炸。
      return { action: action.action, txHash: action.txHash };
    },
  };
}

/** 打印七步输出。数据全部来自 `runCase()` 的返回值，脚本不自己再算一遍。 */
async function report(
  result: CaseResult,
  ctx: {
    readonly jobClient: JobClient;
    readonly adjudicatorMode: string;
    readonly feeSource: string;
    readonly feeFromChain: boolean;
    readonly provenance: FixtureProvenance | null;
    readonly moduleResponse: ModuleResponse;
    /** 案件状态机里的状态——唯一真相源，重放时链上状态查不到也照样有它。 */
    readonly caseState: string;
  },
): Promise<void> {
  // 请求级幂等命中时**不去查链**：这一跑什么都没执行，dry-run 的 Job 替身还是
  // 进程内的新实例，它根本没有这个 Job。查了只会得到一个与本次无关的错误。
  // 案件状态一律从**状态机**读——它是唯一真相源，链上状态只用于对账（合约 §3）。
  const chainState = result.replayed ? null : await ctx.jobClient.getJobState(result.jobId);
  say(
    `[2/7] 8183：jobId=${result.jobId.toString()} 案件状态=${ctx.caseState}` +
      `${chainState === null ? "（本次未查链：请求级幂等命中）" : ` 链上状态=${chainState}`}`,
  );
  say(
    `[3/7] x402：${ctx.moduleResponse.module}@${ctx.moduleResponse.version} ` +
      `overall=${ctx.moduleResponse.overall}` +
      `${result.procurement?.reused === true ? "（复用本案已有采购，**本次没付款**）" : ""}`,
  );

  reportAdjudication(result.adjudication, ctx.adjudicatorMode);
  say(
    `[4/7] 判定：legs=${result.sa.legs.length} ` +
      `condition=${result.sa.legs.map((l) => l.condition).join(",")}` +
      `（由 Module 结果推导，**与上面的 verdict 无关**）` +
      ` confidence=${result.sa.legs.map((l) => l.confidence).join(",")}`,
  );
  say(`  · 五出口路由：${result.routing.exit} → 链上动作 ${result.routing.chainAction}（${result.routing.actor}）`);
  say(`[5/7] SA：sa_hash=${result.saHash} signer=${result.sa.attestation.signer}（运营密钥）`);

  for (const outcome of result.verification.outcomes) {
    say(
      `  · ${outcome.check}: ${outcome.passed ? "PASS" : `FAIL ${outcome.failures.map((f) => f.code).join(",")}`}`,
    );
  }
  say(`[6/7] 三检：${result.verification.passed ? "全过" : "未通过"} reasonHash=${result.verification.reasonHash}`);
  say(
    `[7/7] 收口：${result.settlement?.action ?? "未收口"} tx=${result.settlement?.txHash ?? "无"} ` +
      `案件状态=${ctx.caseState}`,
  );

  say(`      费率来源：${ctx.feeSource}`);
  const split = feeSplitFromLedger(result.ledger);
  if (split === null) {
    say("      案件费拆分：未记（本次未 complete，escrow 未放款）");
  } else {
    say(
      `      案件费拆分：budget=${formatUsdc6(usdc6(split.budget))} ` +
        `platformFee=${formatUsdc6(usdc6(split.platformFee))} ` +
        `evalFee=${formatUsdc6(usdc6(split.evaluatorFee))} ` +
        `provider 实收 net=${formatUsdc6(usdc6(split.net))}` +
        explainNet(split, ctx.feeFromChain),
    );
  }
  reportLedger(result.ledger, ctx.provenance);
  say(`      账本落盘：库内该案件共 ${String(result.ledger.length)} 行`);

  // 幂等的实证：重跑同一 caseId 时**请求级**就命中了，一步都不会重跑。
  say(
    result.replayed
      ? "      ⟳ 请求级幂等命中：本次一步都没重跑（没建 Job、没付费、没入账），以上为首跑快照"
      : "      本次为首跑：以上链上写、采购与入账均实际发生了一次",
  );
}

async function main(): Promise<void> {
  loadDotEnvFile(join(import.meta.dirname, "..", ".env"));
  const config = resolveSliceConfig(process.argv.slice(2), process.env);
  // 入口即登记：之后每一次 say()/错误输出都会自动屏蔽这四把钥匙，
  // 不必指望每个打印点记得脱敏。
  for (const key of Object.values(config.keys)) registerSecret(key);
  const addresses = deriveAddresses(config.keys);

  say(`\n=== Citely 纵切演示（${config.dryRun ? "DRY RUN：不发交易、不付费" : "真实 Arc Testnet"}）===`);
  if (config.ephemeralKeys) {
    say("⚠️  未检测到 .env，本次使用**当场生成的一次性演示密钥**；不会产生任何链上效果。");
  }
  say(`client=${addresses.marketplace} provider=${addresses.operator} evaluator=${addresses.verifier}`);

  // ① intake 只为**打印**跑一次（纯函数、无副作用）。编排内部会再跑一次同样的
  //    intake——这不是"两套逻辑"，是同一个函数被调了两次，结果必然一致。
  const facts = intake(CLEAN_DEAL_INPUT);
  say(`\n[1/7] intake：material_sha256=${facts.material_sha256} flags=[${facts.detected_flags.join(",")}]`);

  // 费率先读：dry-run 也真读链上 view（只读、不花钱），读到多少显示多少。
  // 替身的 getFeeRates() 直接回吐这份链上值，账本算的就是真费率。
  const { fees, source: feeSource, fromChain: feeFromChain } = await resolveFeeRates(config.jobContract);

  // 本地状态库：状态机 + 幂等表 + 账本 + 采购表 + 运行快照。dry-run 也落盘
  //（用独立库），否则彩排验的东西和真跑时不是一套。
  const store = openSlicePersistence(config.dryRun);
  say(`  · 状态库：${store.dbPath}`);

  const jobClient = buildJobClient(config, addresses, fees, store.idempotency);

  const demoRubric = loadDemoRubric();
  const rubric = demoRubric.loaded;
  const adjudicatorMode = parseAdjudicatorMode(process.env["ADJUDICATOR_MODE"]);
  const adjudicatorLlm = createAdjudicatorLLM(process.env);
  say(
    `  · 判定器：${adjudicatorLlm.id} effort=${adjudicatorLlm.fingerprint.reasoningEffort ?? "(未发送)"} ` +
      `temperature=${adjudicatorLlm.fingerprint.temperature === null ? "(未发送)" : String(adjudicatorLlm.fingerprint.temperature)}`,
  );
  say(
    `  · rubric：${demoRubric.isReal ? "真 rubric" : "⚠️ 随包演示 rubric"} ` +
      `${rubric.id}@${rubric.rubric.version} 判定项 ${rubric.rubric.items.length} 个（${demoRubric.source}）`,
  );

  const { x402, provenance } = await buildX402Client(config);
  // 信任根要用到 Module 的版本与规则哈希；dry-run 下取自录制快照。
  const { response: trustModuleResponse } = loadModuleResponse();
  const ports = await buildVerifierPorts(config, jobClient, addresses.operator, trustModuleResponse);

  const deps: RunCaseDeps<VerificationReport> = {
    jobClient,
    stores: {
      cases: new CaseStore(store.db),
      ledger: new LedgerStore(store.db),
      runs: new CaseRunStore(store.db),
      purchases: new PurchaseStore(store.db),
    },
    adjudicator: {
      llm: adjudicatorLlm,
      cache: new FileGoldenCache({
        dir: join(findRepoRoot(), "demo", "golden", "adjudication"),
        provider: adjudicatorLlm.fingerprint.provider,
        model: adjudicatorLlm.fingerprint.model,
      }),
      mode: adjudicatorMode,
    },
    x402,
    operatorAccount: privateKeyToAccount(config.keys.operator),
    ...ports,
    logger: log,
  };

  // **唯一的编排调用**：服务侧走的是同一个函数。
  const result = await runCase(
    {
      caseId: CLEAN_DEAL_INPUT.deal_id,
      deal: CLEAN_DEAL_INPUT,
      rubric,
      module: { id: MODULE_ID, quotedPriceAtomic: MODULE_PRICE_ATOMIC },
      job: {
        provider: addresses.operator,
        evaluator: addresses.verifier,
        expiredAt: CASE_EXPIRES_AT_UNIX,
        budgetAtomic: CASE_FEE_ATOMIC,
        // 不变量 4：链上只放不透明案件引用，业务内容一个字都不上链。
        description: buildCaseDescription(CLEAN_DEAL_INPUT.deal_id),
      },
      settlement: { party: PARTY, payee: PAYEE, amountAtomic: PAYOUT_ATOMIC },
      chainId: config.chainId,
      // 出口 4（解释性 gray / 买过仍未消解的数据缺口）要产出升级材料。
      // 本案的 4 个 gray_data 判定项在采购后仍未消解，按 v2.3 §2.2 正是出口 4，
      // 缺这份配置编排会响亮失败——这正是我们要的：不许悄悄跳过升级。
      escalation: {
        // 专家的钱永远来自委托人（Marketplace），不是 Citely。
        client: addresses.marketplace,
        provider: addresses.operator,
        evaluator: addresses.verifier,
        expiresAt: REVIEW_EXPIRES_AT,
        deposit: REVIEW_DEPOSIT_ATOMIC,
      },
    },
    deps,
  );

  // 采购到的真实响应从**采购表**读回（它是这次采购的记录，不是另一份快照）。
  const purchase = deps.stores.purchases.find(CLEAN_DEAL_INPUT.deal_id, MODULE_ID);
  await report(result, {
    jobClient,
    adjudicatorMode,
    feeSource,
    feeFromChain,
    provenance,
    moduleResponse: purchase?.response ?? trustModuleResponse,
    caseState: deps.stores.cases.getCase(CLEAN_DEAL_INPUT.deal_id).state,
  });

  // 客户侧：钱包按自有预设策略核验 SA，自行决定是否付款给收款方
  const agent = new MarketplaceAgent({
    jobClient,
    paymentExecutor: createDryRunPaymentExecutor().executor,
    policy: walletPolicy([addresses.operator, addresses.verifier], addresses.operator),
  });
  const run = await agent.reviewAndSettle({
    saJson: JSON.parse(JSON.stringify(result.sa)),
    fundedJobId: result.jobId,
  });
  reportWalletDecision(run);
  // 关连接：WAL 模式下不关会留下 -wal/-shm 兄弟文件。
  store.close();
  say("输出为基于公开法源整理的检查项状态，不构成法律意见。\n");
}

try {
  await main();
} catch (err) {
  // 响亮失败：不吞错、不降级、不泄密。
  log.error("vertical slice aborted", { error: safeErrorMessage(err) });
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`\n✗ 纵切演示中止：${redactSecrets(detail)}\n`);
  process.exitCode = 1;
}
