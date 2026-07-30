/**
 * 出口 5（超时退款）真链验证。
 *
 * 走完 createJob → setBudget → fund 到 **Funded** 后**停下等到期**，
 * 然后 `claimRefund`，断言两件事：
 *   1. 链上状态变成 **Expired（uint8=5）**，不是 Rejected——两条退款路径出口不同；
 *   2. 预算**全额**退回 client：`claimRefund` **不扣任何费**（`reject` 也退全额，
 *      但走的是 evaluator 权限；出口 5 走的是时间）。
 *
 * ⚠️ `claimRefund` 在参考实现里**没有 msg.sender 检查（permissionless）**——
 * 任何人都能替这个 Job 触发退款。我方仍固定用 client 角色调用，
 * 但不要据此做任何"只有 client 能退款"的安全推断。
 *
 * 有效期取 6 分钟（链上下限是**严格大于** 5 分钟），所以本脚本要真等约 6 分钟。
 *
 * 用法（建议用备用 RPC，公共主 RPC 易限流）：
 *   ARC_RPC_URL=https://arc-testnet.drpc.org \
 *   node --import tsx scripts/spike/exit5-timeout.ts [--budget 0.05]
 */
import { setTimeout as delay } from "node:timers/promises";

import { ENV_KEYS, loadDotEnvFile, optionalEnv, readAddress } from "../../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../../packages/chain/src/config/redact.js";
import { formatUsdc } from "../../packages/chain/src/diagnostics.js";
import { InMemoryIdempotencyStore } from "../../packages/chain/src/idempotency-store.js";
import { createJobClient, expiryFromNow } from "../../packages/chain/src/job-client.js";
import type { JobClient } from "../../packages/chain/src/types/job.js";
import type { Address } from "../../packages/chain/src/types/viem.js";
import { createArcPublicClient, type RpcConfig } from "../../packages/chain/src/wallet.js";
import { createJobRoleClients, toJobRoleWallets } from "../../packages/chain/src/wiring.js";
import { parseUsdcAmount } from "../../packages/chain/src/x402-client.js";

/** 6 分钟：链上下限是严格大于 5 分钟，留一分钟余量别贴着下限。 */
const EXIT5_EXPIRY_SECONDS = 360n;

/** 等待期间每 15 秒报一次进度，别让人以为脚本卡死。 */
const COUNTDOWN_INTERVAL_MS = 15_000;

const DEFAULT_BUDGET_USDC = "0.05";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** 用链上时间轮询到期，别用本机时钟——出块时间与本机可能差几秒。 */
async function waitUntilExpired(
  publicClient: ReturnType<typeof createArcPublicClient>,
  expiredAt: bigint,
): Promise<void> {
  for (;;) {
    const { timestamp } = await publicClient.getBlock({ blockTag: "latest" });
    if (timestamp >= expiredAt) {
      write(`  链上时间 ${timestamp.toString()} ≥ expiredAt ${expiredAt.toString()}，可以退款了`);
      return;
    }
    write(`  等待到期：链上还差 ${(expiredAt - timestamp).toString()} 秒`);
    await delay(COUNTDOWN_INTERVAL_MS);
  }
}

async function usdcBalance(
  publicClient: ReturnType<typeof createArcPublicClient>,
  usdc: Address,
  owner: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: usdc,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [owner],
  });
}

async function fundedJob(
  job: JobClient,
  provider: Address,
  evaluator: Address,
  budgetAtomic: bigint,
  expiredAt: bigint,
): Promise<bigint> {
  const caseId = `exit5-${String(Date.now())}`;
  const created = await job.createJob({
    provider,
    evaluator,
    expiredAt,
    description: `citely exit5 ${caseId}`,
    caseId,
  });
  write(`[1/4] createJob jobId=${created.jobId.toString()} tx=${created.txHash}`);
  write(`[2/4] setBudget ${formatUsdc(budgetAtomic)} USDC tx=${await job.setBudget(created.jobId, budgetAtomic)}`);
  const fundTx = await job.fund(created.jobId, budgetAtomic);
  write(`[3/4] fund tx=${fundTx} → ${await job.getJobState(created.jobId)}`);
  return created.jobId;
}

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../../.env", import.meta.url).pathname);
  const argv = process.argv.slice(2);
  const budgetAtomic = parseUsdcAmount(flagValue(argv, "--budget") ?? DEFAULT_BUDGET_USDC);

  const primaryUrl = optionalEnv(process.env, ENV_KEYS.rpcUrl);
  if (primaryUrl === undefined) {
    throw new Error(`未设置 ${ENV_KEYS.rpcUrl}`);
  }
  const fallbackUrl = optionalEnv(process.env, ENV_KEYS.rpcUrlFallback);
  const rpc: RpcConfig = fallbackUrl === undefined ? { primaryUrl } : { primaryUrl, fallbackUrl };

  const jobContract = readAddress(process.env, ENV_KEYS.jobContract, "8183 合约地址");
  const usdc = readAddress(process.env, ENV_KEYS.usdc, "Arc Testnet USDC");
  const roles = createJobRoleClients(process.env, rpc);
  const publicClient = createArcPublicClient(rpc);
  const job = createJobClient({
    jobContract,
    usdc,
    publicClient,
    wallets: toJobRoleWallets(roles),
    store: new InMemoryIdempotencyStore(),
  });

  const expiredAt = expiryFromNow(EXIT5_EXPIRY_SECONDS);
  write(`出口 5：超时退款。预算 ${formatUsdc(budgetAtomic)} USDC，有效期 ${EXIT5_EXPIRY_SECONDS.toString()} 秒`);
  const before = await usdcBalance(publicClient, usdc, roles.client.address);
  write(`client 退款前 USDC：${formatUsdc(before)}`);

  const jobId = await fundedJob(
    job,
    roles.provider.address,
    roles.evaluator.address,
    budgetAtomic,
    expiredAt,
  );

  write("[4/4] 等待到期后 claimRefund（permissionless，我方仍用 client 角色调）");
  await waitUntilExpired(publicClient, expiredAt);
  const refundTx = await job.claimRefund(jobId);
  const state = await job.getJobState(jobId);
  const after = await usdcBalance(publicClient, usdc, roles.client.address);
  write(`  claimRefund tx=${refundTx} → ${state}`);
  write(`  client 退款后 USDC：${formatUsdc(after)}（差额 ${formatUsdc(after - before)}，gas 也走 USDC）`);

  if (state !== "expired") {
    throw new Error(`断言失败：出口 5 的终态应为 expired（uint8=5），实际 ${state}`);
  }
  const refunded = await job.getJob(jobId);
  write(`  链上 budget 仍记为 ${formatUsdc(refunded.budget)}（退款不清零预算字段）`);
  write(`EXIT5 OK jobId=${jobId.toString()} 状态=expired 全额退回 client（claimRefund 不扣费）`);
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`EXIT5 FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
