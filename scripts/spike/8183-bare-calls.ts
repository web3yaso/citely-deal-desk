/**
 * spike ①（第 0 优先）：探测 ERC-8183 参考合约在 Arc Testnet 上的可用性。
 *
 * 本轮**只读**：
 *   1. RPC 连通与 chainId；
 *   2. `getCode` 探测目标地址上到底有没有字节码；
 *   3. 用 `paymentToken()` / `jobCounter()` 等 view **反证** 我方 ABI 与部署字节码
 *      匹配（能正常 decode 才说明选择子对得上）；
 *   4. 顺带读出费率与 treasury，供账本按净额对账（合约 §2.4）。
 *
 * 加 `--write` 才进入**真链裸调**：createJob → setBudget → fund → submit → complete
 * 各调一次，按 §2.1 用三把不同的钱包。默认不带 `--write`，只读探测**不持任何私钥**。
 *
 * ⚠️ `--write` 会在真链上真的建 Job、真的转 USDC（预算默认 0.10 USDC，`--budget` 可改），
 * 且需要三把钱包都有 gas。
 *
 * 用法：
 *   node --import tsx scripts/spike/8183-bare-calls.ts [--address 0x...]
 *   node --import tsx scripts/spike/8183-bare-calls.ts --write [--budget 0.10]
 * 地址优先级：`--address` > 环境变量 `JOB_CONTRACT_ADDRESS`。
 */
import { ENV_KEYS, readPrivateKey } from "../../packages/chain/src/config/env.js";
import { bytes32FromText } from "../../packages/chain/src/hashing.js";
import { InMemoryIdempotencyStore } from "../../packages/chain/src/idempotency-store.js";
import { createJobClient } from "../../packages/chain/src/job-client.js";
import { createChainClients, type RpcConfig } from "../../packages/chain/src/wallet.js";
import type { Address, Hex } from "../../packages/chain/src/types/viem.js";
import { parseUsdcAmount } from "../../packages/chain/src/x402-client.js";
import { loadDotEnvFile, optionalEnv } from "../../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../../packages/chain/src/config/redact.js";
import { formatUsdc } from "../../packages/chain/src/diagnostics.js";
import { probeJobContract, resolveContractAddress } from "../../packages/chain/src/probe.js";
import { createArcPublicClient } from "../../packages/chain/src/wallet.js";

/** 无 `.env` 时的兜底 RPC，与 `.env.example` 一致。 */
const DEFAULT_RPC = "https://rpc.testnet.arc.network";
const DEFAULT_RPC_FALLBACK = "https://arc-testnet.drpc.org";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 取 `--flag value` 形式的参数值。 */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** 裸调默认预算 0.10 USDC：够验证资金真的流动，又不至于烧掉水龙头额度。 */
const DEFAULT_BUDGET_USDC = "0.10";

/** Job 有效期给足 24 小时——参考实现有 `ExpiryTooShort`，别卡在边界上。 */
const EXPIRY_SECONDS = 86_400n;

/**
 * 真链裸调五个写函数，每步打印 txHash 与状态迁移。
 *
 * 三把钱包按 §2.1 分工注入；任何一步 revert 都会带着 action/jobId/txHash 抛出来。
 */
async function runBareCalls(
  jobContract: Address,
  usdc: Address,
  rpc: RpcConfig,
  budgetAtomic: bigint,
): Promise<void> {
  const marketplace = createChainClients(
    "marketplace",
    readPrivateKey(process.env, ENV_KEYS.marketplaceKey),
    rpc,
  );
  const operator = createChainClients(
    "operator",
    readPrivateKey(process.env, ENV_KEYS.operatorKey),
    rpc,
  );
  const verifier = createChainClients(
    "verifier",
    readPrivateKey(process.env, ENV_KEYS.verifierKey),
    rpc,
  );
  write(`client(marketplace) = ${marketplace.address}`);
  write(`provider(operator)  = ${operator.address}`);
  write(`evaluator(verifier) = ${verifier.address}`);

  const job = createJobClient({
    jobContract,
    usdc,
    publicClient: marketplace.publicClient,
    wallets: {
      client: marketplace.walletClient,
      provider: operator.walletClient,
      evaluator: verifier.walletClient,
    },
    store: new InMemoryIdempotencyStore(),
  });

  const caseId = `spike-${String(Date.now())}`;
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + EXPIRY_SECONDS;
  const deliverable: Hex = bytes32FromText(`${caseId}:deliverable`);
  const reason: Hex = bytes32FromText(`${caseId}:ok`);

  write(`\n[裸调 1/5] createJob（client）caseId=${caseId}`);
  const created = await job.createJob({
    provider: operator.address,
    evaluator: verifier.address,
    expiredAt,
    description: `citely spike ${caseId}`,
    caseId,
  });
  write(`  jobId=${created.jobId.toString()} tx=${created.txHash} → ${await job.getJobState(created.jobId)}`);

  const jobId = created.jobId;
  write(`[裸调 2/5] setBudget（provider）${formatUsdc(budgetAtomic)} USDC`);
  write(`  tx=${await job.setBudget(jobId, budgetAtomic)} → ${await job.getJobState(jobId)}`);

  write("[裸调 3/5] fund（client，含 approve + 抢跑复读）");
  write(`  tx=${await job.fund(jobId, budgetAtomic)} → ${await job.getJobState(jobId)}`);

  write("[裸调 4/5] submit（provider）");
  write(`  tx=${await job.submit(jobId, deliverable)} → ${await job.getJobState(jobId)}`);

  write("[裸调 5/5] complete（evaluator）");
  write(`  tx=${await job.complete(jobId, reason)} → ${await job.getJobState(jobId)}`);

  const fees = await job.getFeeRates();
  write(
    `费率复核：platformFeeBP=${fees.platformFeeBP.toString()}，` +
      `evaluatorFeeBP=${fees.evaluatorFeeBP.toString()}（链上读取，非硬编码）`,
  );
}

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../../.env", import.meta.url).pathname);
  const argv = process.argv.slice(2);
  const address = resolveContractAddress(argv, optionalEnv(process.env, "JOB_CONTRACT_ADDRESS"));
  const rpc: RpcConfig = {
    primaryUrl: optionalEnv(process.env, "ARC_RPC_URL") ?? DEFAULT_RPC,
    fallbackUrl: optionalEnv(process.env, "ARC_RPC_URL_FALLBACK") ?? DEFAULT_RPC_FALLBACK,
  };
  const client = createArcPublicClient(rpc);

  write(`探测目标：${address}`);
  const probe = await probeJobContract(client, address);
  write(`[1/4] chainId = ${String(probe.chainId)}`);
  write(`[2/4] 字节码长度 = ${String(probe.codeSize)} 字节`);
  if (probe.verdict === "NO_CODE") {
    write("[3/4] 跳过 view 反证：地址上没有合约");
    write(
      "结论 = NO_CODE：该地址无部署。需主导批准部署方案" +
        "（UUPS 实现 + ERC1967 代理 + initialize(paymentToken, treasury)）后由用户执行。",
    );
    process.exitCode = 1;
    return;
  }
  write(`[3/4] paymentToken() = ${probe.paymentToken}`);
  write(`[3/4] jobCounter()   = ${probe.jobCounter.toString()}`);
  write(
    `[4/4] platformFeeBP = ${probe.platformFeeBP.toString()}，` +
      `evaluatorFeeBP = ${probe.evaluatorFeeBP.toString()}，treasury = ${probe.platformTreasury}`,
  );
  const budget = 1_000_000n;
  const net =
    budget - (budget * probe.platformFeeBP) / 10_000n - (budget * probe.evaluatorFeeBP) / 10_000n;
  write(`[4/4] 1.000000 USDC 预算 → provider 实收 ${formatUsdc(net)} USDC（§2.4 净额）`);
  if (probe.verdict === "NOT_INITIALIZED") {
    write("结论 = NOT_INITIALIZED：paymentToken 为零地址，合约未 initialize，fund 必然失败");
    process.exitCode = 1;
    return;
  }
  write(`结论 = ${probe.verdict}：可直接把该地址填进 JOB_CONTRACT_ADDRESS`);

  if (!argv.includes("--write")) {
    write("（只读模式。加 --write 做真链裸调：会真的建 Job 并转 USDC）");
    return;
  }
  const budgetAtomic = parseUsdcAmount(flagValue(argv, "--budget") ?? DEFAULT_BUDGET_USDC);
  // paymentToken 直接用链上读出来的，不用 env：approve 错币种是最难查的一类错。
  await runBareCalls(address, probe.paymentToken, rpc, budgetAtomic);
  write("SPIKE-8183 BARE CALLS OK");
}

try {
  await main();
} catch (error: unknown) {
  // 只读脚本不持私钥，仍统一过 redact：RPC 报错可能回显整段请求。
  process.stderr.write(`SPIKE-8183 FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
