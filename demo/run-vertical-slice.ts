/**
 * 纵切端到端演示：intake → 8183 → 判定 → x402 → SA → 三检 → complete。
 *
 * ```
 * node --import tsx demo/run-vertical-slice.ts --dry-run   # 不发交易、不付费
 * node --import tsx demo/run-vertical-slice.ts             # 真实 testnet
 * ```
 *
 * 硬纪律：
 * - **任何一步失败都响亮报错中止**，不许静默降级。真实模式缺密钥/缺地址即退出，
 *   绝不自动退回 dry-run；
 * - **不打印密钥**，所有错误过 `redactSecrets` 再出；
 * - 金额**照实显示**，不预设结论：`complete` 会扣 platformFee + evalFee
 *   （合约 §2.4），但费率是链上变量，当前部署可能就是 0。既不断言
 *   "provider 收到 = budget"，也不断言"一定不等于"——读到多少显示多少。
 *   **`--dry-run` 也真读链上费率**（`platformFeeBP()` 是 view，只读不花钱）：
 *   印一行"费率读链上 view"却配编造的数字，是最坏的一种假；
 * - 打印的金额全部来自 **engine 的账本条目**（`entriesForComplete`），
 *   演示脚本不自己算一遍净额——两套算法对上了也证明不了账本是对的；
 * - SA 是"条件证明，由钱包按自有预设策略核验执行"，不是 Citely 授权付款。
 *
 * 免责声明：输出为基于公开法源整理的检查项状态，不构成法律意见。
 */

import { loadDotEnvFile } from "@citely/chain";
import type { ModuleResponse } from "@citely/chain";
import { redactSecrets, registerSecret, safeErrorMessage } from "@citely/chain";
import { createLogger, findRepoRoot, formatUsdc6, usdc6 } from "@citely/engine";
import {
  adjudicateRubric,
  createAdjudicatorLLM,
  FileGoldenCache,
  parseAdjudicatorMode,
  toItemVerdicts,
} from "@citely/engine/adjudicator";
import type { AdjudicatedItem } from "@citely/engine/adjudicator";
import type { LedgerEntry } from "@citely/engine/ledger";
import { MarketplaceAgent, PAYOUT_RULE_SUMMARY } from "@citely/marketplace";
import type { SettlementDecision, SettlementRun, WalletSettlementPolicy } from "@citely/marketplace";
import { settleVerifiedJob, verifySettlementAuthorization } from "@citely/verifier";
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
import { createDryRunPaymentExecutor } from "./slice/doubles.js";
import { buildJobClient } from "./slice/job-client.js";
import { openSlicePersistence, recordLedgerIdempotent } from "./slice/persistence.js";
import {
  assembleSa,
  buildSettlementLegs,
  completeLedger,
  intake,
  procurementLedger,
} from "./slice/stages.js";
import type { FeeBreakdown } from "./slice/stages.js";
import { resolveFeeRates } from "./slice/fees.js";
import { loadPurchase, purchaseCachePath, savePurchase } from "./slice/purchase-cache.js";
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

/**
 * 案件 Job 的 `expiredAt`（Unix 秒）——**写死，不用 `Date.now()`**。
 *
 * 它经 `createJob` 上链，再被回读进 SA 的 `bound_to.expires_at`，而后者在
 * `deliverableHash` 的输入里。取墙上时钟的话每跑一次就换一个 `sa_hash`，
 * "同样输入 → 同样 SA"这条对外承诺当场失效（2026-07-29/30 两次事故的共同根因）。
 *
 * 合成案件本来就该冻结——与 v2.2 §9「双轨金额写死在合成数据里，杜绝现场手输」
 * 同一条纪律。演示日之后若这个时刻过期，改这一个常量即可。
 */
const CASE_EXPIRES_AT_UNIX = BigInt(Math.floor(Date.parse("2026-12-31T00:00:00.000Z") / 1000));

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
 * 取 Module 结果。
 *
 * dry-run 用录制快照（`--dry-run` 明确定义为不付费，而 check 是 x402 付费端点）；
 * 真实模式走**真实 msb-agent**。两条分支互斥，真实模式绝不回落到快照。
 */
/** 本次采购的来源标注；dry-run 下由录制提供，真实模式下由 x402 返回填。 */
let moduleProvenance: FixtureProvenance | null = null;
/** 本次采购的 Gateway 回执与实付金额；dry-run 用录制里的。 */
let procurement: { readonly receipt: string; readonly paid: bigint } | null = null;

async function fetchModuleResult(
  config: SliceConfig,
  dbPath: string,
): Promise<ModuleResponse> {
  if (config.dryRun) {
    // 有真实录制就用真的，没有才用合成替身——两者的来源如实打印出来，
    // 不让人把"排练用的构造数据"误当成"线上真实返回"。
    const { provenance, response } = loadModuleResponse();
    moduleProvenance = provenance;
    say(
      `  · Module 结果：${provenance.source === "recorded" ? "真实录制" : "⚠️ 合成替身"}` +
        `（${provenance.module}@${provenance.version}，${provenance.capturedAt}）——--dry-run 不付费`,
    );
    if (provenance.source !== "recorded") say(`    ${provenance.note}`);
    if (provenance.settlementId !== undefined) {
      // 录制里带了回执才能记采购账；没有就不记，绝不编一个回执号。
      procurement = { receipt: provenance.settlementId, paid: MODULE_PRICE_ATOMIC };
    }
    return response;
  }
  // 不变量 6「重试不重复付款」：x402 是**链下**付款，不走 IdempotencyStore
  // 那条路径，所以采购幂等要在这里自己管。同一案件的同一 Module 只买一次。
  const cachePath = purchaseCachePath(dbPath, CLEAN_DEAL_INPUT.deal_id, "us-msb");
  const cached = loadPurchase(cachePath);
  if (cached !== null) {
    say(`  · Module 结果：复用本案已有采购（${cached.purchasedAt}）——**不重复付款**（不变量 6）`);
    say(`    回执 ${cached.settlementId}，当初实付 ${formatUsdc6(usdc6(BigInt(cached.paidAtomic)))} USDC`);
    procurement = { receipt: cached.settlementId, paid: BigInt(cached.paidAtomic) };
    return cached.response;
  }

  const { createGatewayClient, createX402Client } = await import("@citely/chain");
  const x402 = createX402Client({
    baseUrl: config.msbAgentBaseUrl,
    gateway: createGatewayClient(config.keys.procurement, config.rpcUrl ?? undefined),
  });
  say("  · Module 结果：本案首次采购，正在真实调用 x402（会付费）…");
  const result = await x402.check("us-msb", CLEAN_DEAL_INPUT);
  procurement = { receipt: result.settlementId, paid: result.paidAtomic };
  savePurchase(cachePath, {
    response: result.response,
    settlementId: result.settlementId,
    paidAtomic: result.paidAtomic.toString(),
    purchasedAt: new Date().toISOString(),
  });
  return result.response;
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

/**
 * 解释 `net` 与 `budget` 的关系。
 *
 * **只有费率真的来自链上时才敢说"当前部署费率为 0"**——占位值也是 0，
 * 拿占位值去断言链上部署的费率，就是把一句猜测说成实测。
 *
 * @param split - 账本算出的金额拆分
 * @param feeFromChain - 费率是否真的读自链上
 * @returns 附在金额后面的说明
 */
function explainNet(split: FeeBreakdown, feeFromChain: boolean): string {
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
 * 因此这里按 `ref_type` 分别标注引用的性质，并且：
 * - `gateway_receipt` 行在批量结算前显示"待结算"，结算后补挂 `settlement_tx`；
 * - **`settlement_tx` 为 `null` 时如实显示"待结算"，绝不省略或伪造**。
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
 * 打印采购与版税账本行（v2.3 §3.5，`ref_type = gateway_receipt`）。
 *
 * 三道闸，任何一道不满足就**不打印这两行**，而不是打印一个占位数字：
 * 1. 有 Gateway 回执——`module_fee`/`royalty` 的 `ref` 必须是它，编不得；
 * 2. 版税字段来自真实录制（`assertRoyaltyRenderable`）；
 * 3. `maintainer_wallet` 非零且 `royalty_bps > 0`——零地址按 docs/api.md
 *    是"无版税应付"，且**不得**向零地址转账。
 *
 * @param moduleResponse - 本次采购的 Module 响应
 */
function reportProcurementLedger(moduleResponse: ModuleResponse): readonly LedgerEntry[] {
  if (procurement === null) {
    say("      采购账本：未记（本次没有 Gateway 回执——回执是 module_fee/royalty 的 ref，不编造）");
    return [];
  }
  if (moduleProvenance !== null) {
    try {
      assertRoyaltyRenderable(moduleProvenance);
    } catch {
      say("      采购账本：版税字段未经录制，仅记 module_fee，不渲染版税行");
    }
  }
  const rows = procurementLedger({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    quoted: MODULE_PRICE_ATOMIC,
    paid: usdc6(procurement.paid),
    gatewayReceipt: procurement.receipt,
    maintainerWallet: moduleResponse.maintainer_wallet,
    royaltyBps: moduleResponse.royalty_bps,
  });
  for (const row of rows) say(`      账本 ${formatLedgerRow(row)}`);
  if (!rows.some((r) => r.category === "royalty")) {
    say(
      `      （无版税行：maintainer_wallet=${moduleResponse.maintainer_wallet} ` +
        `royalty_bps=${String(moduleResponse.royalty_bps)} → 按 api.md 无版税应付）`,
    );
  }
  return rows;
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

  // ① intake：材料过沙箱（不变量 5）
  const facts = intake(CLEAN_DEAL_INPUT);
  say(`\n[1/7] intake：material_sha256=${facts.material_sha256} flags=[${facts.detected_flags.join(",")}]`);

  // ② 8183：createJob（client）→ setBudget（provider）→ approve+fund（client）
  //
  // 费率先读：dry-run 也真读链上 view（只读、不花钱），读到多少显示多少。
  // 替身的 getFeeRates() 直接回吐这份链上值，账本算的就是真费率。
  const { fees, source: feeSource, fromChain: feeFromChain } = await resolveFeeRates(
    config.jobContract,
  );
  // 本地状态库：状态机 + 幂等表 + 账本。dry-run 也落盘（用独立库），
  // 否则彩排验的东西和真跑时不是一套。
  const store = openSlicePersistence(config.dryRun);
  say(`  · 状态库：${store.dbPath}`);
  store.cases.ensureCase(CLEAN_DEAL_INPUT.deal_id);

  // 幂等存储注入 JobClient：真实模式下每个写方法进入即 lookup，命中直接返回既有 txHash。
  // ⚠️ dry-run 走的是 `createDryRunJobClient` 替身，它**不查这个 store**
  // （替身把 Job 存在进程内存里，重跑时 jobId 会从 1 重新开始）。
  // 所以 dry-run 实证的是**账本与案件状态**的幂等；链上写操作的幂等由
  // `pnpm -F @citely/engine idempotency:check` 与 `src/db/rerun.test.ts` 单独实证。
  const jobClient = buildJobClient(config, addresses, fees, store.idempotency);
  const agent = new MarketplaceAgent({
    jobClient,
    paymentExecutor: createDryRunPaymentExecutor().executor,
    policy: walletPolicy([addresses.operator, addresses.verifier], addresses.operator),
  });
  const expiredAt = CASE_EXPIRES_AT_UNIX;
  const { jobId } = await agent.openCase({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    provider: addresses.operator,
    evaluator: addresses.verifier,
    expiredAt,
  });
  await jobClient.setBudget(jobId, CASE_FEE_ATOMIC);
  await agent.fundCase(jobId, CASE_FEE_ATOMIC);
  store.cases.setJobId(CLEAN_DEAL_INPUT.deal_id, jobId);
  say(`[2/7] 8183：jobId=${String(jobId)} 状态=${await jobClient.getJobState(jobId)}`);

  // ③ 判定 + ④ x402 采购
  const demoRubric = loadDemoRubric();
  const rubric = demoRubric.loaded;

  // 判定器接线：provider 由 env 决定（模型必须是带日期 snapshot），
  // golden cache 落 demo/golden/adjudication/<provider>/<model>/。
  // 默认 cache_first：首次真调并录 golden，之后命中缓存 → 离线可复现（v2.3 §9）。
  const adjudicatorMode = parseAdjudicatorMode(process.env["ADJUDICATOR_MODE"]);
  const adjudicatorLlm = createAdjudicatorLLM(process.env);
  const goldenCache = new FileGoldenCache({
    dir: join(findRepoRoot(), "demo", "golden", "adjudication"),
    provider: adjudicatorLlm.fingerprint.provider,
    model: adjudicatorLlm.fingerprint.model,
  });
  say(
    `  · 判定器：${adjudicatorLlm.id} effort=${adjudicatorLlm.fingerprint.reasoningEffort ?? "(未发送)"} ` +
      `temperature=${adjudicatorLlm.fingerprint.temperature === null ? "(未发送)" : String(adjudicatorLlm.fingerprint.temperature)}`,
  );
  say(
    `  · rubric：${demoRubric.isReal ? "真 rubric" : "⚠️ 随包演示 rubric"} ` +
      `${rubric.id}@${rubric.rubric.version} 判定项 ${rubric.rubric.items.length} 个（${demoRubric.source}）`,
  );
  const moduleResponse = await fetchModuleResult(config, store.dbPath);
  say(`[3/7] x402：${moduleResponse.module}@${moduleResponse.version} overall=${moduleResponse.overall}`);

  // ④ 判定：**真判定器**（此前这里是硬编码 confirmed_exempt，判定器在演示路径上
  // 一次都没执行过——错误的模型 ID 能潜伏那么久正是因为这个）。
  // verdict 只流向 basis[] 与 confidence，**condition 依旧只由 Module 结果推导**（不变量 2）。
  const adjudicated = await adjudicateRubric({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    rubric,
    facts,
    deps: { llm: adjudicatorLlm, cache: goldenCache, mode: adjudicatorMode },
  });
  reportAdjudication(adjudicated, adjudicatorMode);

  const legs = buildSettlementLegs({
    payee: PAYEE,
    amountAtomic: PAYOUT_ATOMIC,
    moduleResponse,
    rubric,
    verdicts: toItemVerdicts(adjudicated),
  });
  say(
    `[4/7] 判定：legs=${legs.length} condition=${legs.map((l) => l.condition).join(",")}` +
      `（由 Module 结果推导，**与上面的 verdict 无关**）` +
      ` confidence=${legs.map((l) => l.confidence).join(",")}`,
  );

  // ⑤ SA：由**运营密钥**签（合约 §5.1），provider 提交哈希上链
  const sa = await assembleSa({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    jobId,
    // 从**链上回读**，而不是本地再算一次墙上时钟：本地变量是"这次准备发给
    // createJob 的值"，重跑时会被重新计算；链上那个值才是唯一真相，
    // 且重跑时必然一致——sa_hash 的可复算性依赖这一点。
    expiresAt: (await jobClient.getJob(jobId)).expiredAt,
    moduleResponse,
    legs,
    itemsCovered: rubric.rubric.items.length,
    operatorAccount: privateKeyToAccount(config.keys.operator),
    chainId: config.chainId,
  });
  await jobClient.submit(jobId, sa.attestation.sa_hash);
  say(`[5/7] SA：sa_hash=${sa.attestation.sa_hash} signer=${sa.attestation.signer}（运营密钥）`);

  // ⑥ 三检：独立验证器、独立密钥
  //
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
        operator: addresses.operator,
        // 第四把一次性密钥：Module 认证方与运营/验证器都不是同一个人。
        attester: privateKeyToAccount(generatePrivateKey()),
        modules: [{ moduleId: moduleResponse.module, version: moduleResponse.version }],
        rulesHash: `0x${moduleResponse.evidence_hash}`,
        chainId: config.chainId,
      })
    : loadRepoTrust();
  say(`  · 信任根：${trust.source}`);
  const report = await verifySettlementAuthorization({
    sa,
    rubric: rubric.rubric,
    manifest: trust.manifest,
    registry: trust.registry,
    submittedDeliverableHash: sa.attestation.sa_hash,
    chainId: config.chainId,
  });
  for (const outcome of report.outcomes) {
    say(`  · ${outcome.check}: ${outcome.passed ? "PASS" : `FAIL ${outcome.failures.map((f) => f.code).join(",")}`}`);
  }
  say(`[6/7] 三检：${report.passed ? "全过" : "未通过"} reasonHash=${report.reasonHash}`);

  // ⑦ 收口：三检全过 → complete；受理失败在 Funded/Submitted 态 → reject
  const action = await settleVerifiedJob({ jobClient, jobId, report });
  say(`[7/7] 收口：${action.action} tx=${action.txHash} 状态=${await jobClient.getJobState(jobId)}`);

  // 金额一律从 engine 的账本条目读出，演示脚本不自己算一遍净额——
  // 两套算法对上了也证明不了账本是对的。
  // case_fee 的 ref 是 jobId 而不是 action.txHash（v2.3 §3.5）：案件费是 8183
  // escrow 的放款，Job 才是它的稳定身份——同一个 Job 可能有多笔相关交易。
  const split = completeLedger({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    jobId,
    budget: CASE_FEE_ATOMIC,
    fees: await jobClient.getFeeRates(),
  });
  say(`      费率来源：${feeSource}`);
  say(
    `      案件费拆分：budget=${formatUsdc6(split.budget)} platformFee=${formatUsdc6(split.platformFee)} ` +
      `evalFee=${formatUsdc6(split.evaluatorFee)} provider 实收 net=${formatUsdc6(split.net)}` +
      explainNet(split, feeFromChain),
  );
  for (const entry of split.entries) {
    say(`      账本 ${formatLedgerRow(entry)}`);
  }
  const procurementRows = reportProcurementLedger(moduleResponse);

  // 账本落盘（幂等）：重跑同一案件时全部行都会被 DuplicateLedgerEntryError 挡下，
  // 于是库里的行数与金额不变——这才是"重跑不重复入账"的实证。
  const written = recordLedgerIdempotent(store.ledger, [...split.entries, ...procurementRows]);
  const persisted = store.ledger.list(CLEAN_DEAL_INPUT.deal_id);
  say(
    `      账本落盘：新增 ${String(written.inserted)} 行 / 幂等挡下 ${String(written.skipped)} 行 ` +
      `→ 库内该案件共 ${String(persisted.length)} 行`,
  );

  // 客户侧：钱包按自有预设策略核验 SA，自行决定是否付款给收款方
  const run = await agent.reviewAndSettle({ saJson: JSON.parse(JSON.stringify(sa)), fundedJobId: jobId });
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
