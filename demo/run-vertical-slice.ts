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
 * - 打印金额时**不断言 "provider 收到 = budget"**——`complete` 扣 platformFee +
 *   evalFee，provider 只得 net（合约 §2.4）。费率读链上 view，不硬编码；
 * - SA 是"条件证明，由钱包按自有预设策略核验执行"，不是 Citely 授权付款。
 *
 * 免责声明：输出为基于公开法源整理的检查项状态，不构成法律意见。
 */

import {
  ARC_TESTNET,
  createArcPublicClient,
  createArcTransport,
  createChainClients,
  createJobClient,
  InMemoryIdempotencyStore,
  loadDotEnvFile,
} from "@citely/chain";
import type { JobClient, JobFeeRates, ModuleResponse } from "@citely/chain";
import { redactSecrets, registerSecret, safeErrorMessage } from "@citely/chain";
import { createLogger } from "@citely/engine";
import { MarketplaceAgent } from "@citely/marketplace";
import type { WalletSettlementPolicy } from "@citely/marketplace";
import { settleVerifiedJob, verifySettlementAuthorization } from "@citely/verifier";
import { join } from "node:path";
import { createWalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import { CLEAN_DEAL_INPUT, loadDemoRubric, RECORDED_MODULE_RESPONSE } from "./fixtures/index.js";
import { deriveAddresses, resolveSliceConfig } from "./slice/config.js";
import type { SliceConfig } from "./slice/config.js";
import { createDryRunJobClient, createDryRunPaymentExecutor } from "./slice/doubles.js";
import { assembleSa, buildSettlementLegs, feeBreakdown, intake } from "./slice/stages.js";
import type { ItemVerdicts } from "./slice/stages.js";
import { loadRepoTrust, prepareEphemeralTrust, repoTrustPresent } from "./slice/trust.js";

const log = createLogger("slice");

/** 案件费（名义），6 位小数原子单位。 */
const CASE_FEE_ATOMIC = 3_000_000n;
/** 客户付给收款方的金额，6 位小数原子单位。 */
const PAYOUT_ATOMIC = 12_500_000n;
/** 演示收款方——**不是**任何 Citely 地址（不变量 3）。 */
const PAYEE: Address = "0x000000000000000000000000000000000000BEEF";
/** dry-run 用的费率；真实模式一律读链上 view。 */
const DRY_RUN_FEES: JobFeeRates = { platformFeeBP: 200n, evaluatorFeeBP: 100n };
/** `.env.example` 里的 Arc Testnet RPC 默认值（合约 §8）。 */
const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";
const DEFAULT_ARC_RPC_FALLBACK = "https://arc-testnet.drpc.org";

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

/** 建链上客户端：dry-run 用内存替身，真实模式用 chain 的实现。两条分支互斥。 */
function buildJobClient(config: SliceConfig, addresses: ReturnType<typeof deriveAddresses>): JobClient {
  if (config.dryRun) {
    return createDryRunJobClient({
      client: addresses.marketplace,
      provider: addresses.operator,
      evaluator: addresses.verifier,
      fees: DRY_RUN_FEES,
    }).client;
  }
  if (config.jobContract === null || config.usdc === null) {
    throw new Error("real run requires JOB_CONTRACT_ADDRESS and USDC_ADDRESS");
  }
  const rpc = {
    primaryUrl: config.rpcUrl ?? DEFAULT_ARC_RPC_URL,
    ...(config.rpcUrl === null ? {} : { fallbackUrl: DEFAULT_ARC_RPC_FALLBACK }),
  };
  return createJobClient({
    jobContract: config.jobContract,
    usdc: config.usdc,
    publicClient: createArcPublicClient(rpc),
    wallets: {
      // 8183 client 角色用客户钱包。chain 的 `WalletRole` 目前只有
      // operator/verifier/procurement 三档，没有 client 档（合约 §2.1 要求有），
      // 所以这一把直接用 chain 的 transport/chain 常量自行构造，
      // **不借用别的角色名**——角色名会被审查按"谁动了客户的钱"来 grep。
      client: createWalletClient({
        account: privateKeyToAccount(config.keys.marketplace),
        chain: ARC_TESTNET,
        transport: createArcTransport(rpc),
      }),
      provider: createChainClients("operator", config.keys.operator, rpc).walletClient,
      evaluator: createChainClients("verifier", config.keys.verifier, rpc).walletClient,
    },
    store: new InMemoryIdempotencyStore(),
  });
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
  const jobClient = buildJobClient(config, addresses);
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
  const fees = await jobClient.getFeeRates();
  const split = feeBreakdown(CASE_FEE_ATOMIC, fees);
  say(`[7/7] 收口：${action.action} tx=${action.txHash} 状态=${await jobClient.getJobState(jobId)}`);
  say(
    `      案件费拆分（费率读链上 view）：budget=${String(split.budget)} ` +
      `platformFee=${String(split.platformFee)} evalFee=${String(split.evaluatorFee)} ` +
      `provider 实收 net=${String(split.net)}（**不等于 budget**，合约 §2.4）`,
  );

  // 客户侧：钱包按自有预设策略核验 SA，自行决定是否付款给收款方
  const run = await agent.reviewAndSettle({ saJson: JSON.parse(JSON.stringify(sa)), fundedJobId: jobId });
  say(
    `\n客户钱包核验：execute=${String(run.decision.execute)} ` +
      `payments=${run.decision.payments.map((p) => `${p.party}->${p.to}:${String(p.amountAtomic)}`).join(",") || "无"} ` +
      `blockers=${run.decision.blockers.map((b) => b.code).join(",") || "无"}`,
  );
  say("（SA 是条件证明，由钱包按自有预设策略核验执行；付款目标是收款方，客户资金永不进 Citely 地址。）");
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
