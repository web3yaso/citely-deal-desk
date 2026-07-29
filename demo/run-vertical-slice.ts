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
import { createLogger } from "@citely/engine";
import { MarketplaceAgent, PAYOUT_RULE_SUMMARY } from "@citely/marketplace";
import type { SettlementDecision, SettlementRun, WalletSettlementPolicy } from "@citely/marketplace";
import { settleVerifiedJob, verifySettlementAuthorization } from "@citely/verifier";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import { CLEAN_DEAL_INPUT, loadDemoRubric, RECORDED_MODULE_RESPONSE } from "./fixtures/index.js";
import { deriveAddresses, resolveSliceConfig } from "./slice/config.js";
import type { SliceConfig } from "./slice/config.js";
import { createDryRunPaymentExecutor } from "./slice/doubles.js";
import { buildJobClient } from "./slice/job-client.js";
import { assembleSa, buildSettlementLegs, completeLedger, intake } from "./slice/stages.js";
import type { FeeBreakdown } from "./slice/stages.js";
import type { ItemVerdicts } from "./slice/stages.js";
import { resolveFeeRates } from "./slice/fees.js";
import { loadRepoTrust, prepareEphemeralTrust, repoTrustPresent } from "./slice/trust.js";

const log = createLogger("slice");

/** 案件费（名义），6 位小数原子单位。 */
const CASE_FEE_ATOMIC = 3_000_000n;
/** 客户付给收款方的金额，6 位小数原子单位。 */
const PAYOUT_ATOMIC = 12_500_000n;
/** 演示收款方——**不是**任何 Citely 地址（不变量 3）。 */
const PAYEE: Address = "0x000000000000000000000000000000000000BEEF";

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
async function fetchModuleResult(config: SliceConfig): Promise<ModuleResponse> {
  if (config.dryRun) {
    say("  · Module 结果来自录制快照（--dry-run 不付费）");
    return RECORDED_MODULE_RESPONSE;
  }
  const { createGatewayClient, createX402Client } = await import("@citely/chain");
  const x402 = createX402Client({
    baseUrl: config.msbAgentBaseUrl,
    gateway: createGatewayClient(config.keys.procurement, config.rpcUrl ?? undefined),
  });
  return await x402.check("us-msb", CLEAN_DEAL_INPUT);
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
    decision.payments.map((p) => `${p.party}->${p.to}:${String(p.amountAtomic)}`).join(", ") || "无";
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
  const jobClient = buildJobClient(config, addresses, fees);
  const agent = new MarketplaceAgent({
    jobClient,
    paymentExecutor: createDryRunPaymentExecutor().executor,
    policy: walletPolicy([addresses.operator, addresses.verifier], addresses.operator),
  });
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  const { jobId } = await agent.openCase({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    provider: addresses.operator,
    evaluator: addresses.verifier,
    expiredAt,
  });
  await jobClient.setBudget(jobId, CASE_FEE_ATOMIC);
  await agent.fundCase(jobId, CASE_FEE_ATOMIC);
  say(`[2/7] 8183：jobId=${String(jobId)} 状态=${await jobClient.getJobState(jobId)}`);

  // ③ 判定 + ④ x402 采购
  const demoRubric = loadDemoRubric();
  const rubric = demoRubric.loaded;
  say(
    `  · rubric：${demoRubric.isReal ? "真 rubric" : "⚠️ 随包演示 rubric"} ` +
      `${rubric.id}@${rubric.rubric.version} 判定项 ${rubric.rubric.items.length} 个（${demoRubric.source}）`,
  );
  const moduleResponse = await fetchModuleResult(config);
  say(`[3/7] x402：${moduleResponse.module}@${moduleResponse.version} overall=${moduleResponse.overall}`);

  // 纵切阶段的 verdict 取值：只影响 basis[] 与 confidence，**不影响 condition**（不变量 2）。
  const verdicts: ItemVerdicts = Object.fromEntries(
    rubric.rubric.items.map((item) => [item.id, "confirmed_exempt" as const]),
  );
  const legs = buildSettlementLegs({
    payee: PAYEE,
    amountAtomic: PAYOUT_ATOMIC,
    moduleResponse,
    rubric,
    verdicts,
  });
  say(`[4/7] 判定：legs=${legs.length} condition=${legs.map((l) => l.condition).join(",")}（由 Module 结果推导）`);

  // ⑤ SA：由**运营密钥**签（合约 §5.1），provider 提交哈希上链
  const sa = await assembleSa({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    jobId,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
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
  const split = completeLedger({
    caseId: CLEAN_DEAL_INPUT.deal_id,
    jobId,
    txHash: action.txHash,
    budget: CASE_FEE_ATOMIC,
    fees: await jobClient.getFeeRates(),
  });
  say(`      费率来源：${feeSource}`);
  say(
    `      案件费拆分：budget=${String(split.budget)} platformFee=${String(split.platformFee)} ` +
      `evalFee=${String(split.evaluatorFee)} provider 实收 net=${String(split.net)}${explainNet(split, feeFromChain)}`,
  );
  for (const entry of split.entries) {
    say(
      `      账本 ${entry.account}: ${entry.direction} ${entry.category} ` +
        `nominal=${String(entry.amount_nominal)} actual=${String(entry.amount_actual)} tx=${entry.txHash}`,
    );
  }

  // 客户侧：钱包按自有预设策略核验 SA，自行决定是否付款给收款方
  const run = await agent.reviewAndSettle({ saJson: JSON.parse(JSON.stringify(sa)), fundedJobId: jobId });
  reportWalletDecision(run);
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
