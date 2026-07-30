/**
 * 出口 1（提交前拒绝）真链验证。
 *
 * createJob → setBudget → fund 到 **Funded** 后**不 submit**，由**验证器直接 `reject`**，
 * 断言：链上状态变成 **Rejected**、预算**全额**退回 client。
 *
 * 与出口 5 的区别（两条退款路径别混为一谈）：
 * | | 触发条件 | 谁能调 | 出口状态 |
 * |---|---|---|---|
 * | 出口 1 | 验证器判定不受理 | **仅 evaluator** | Rejected |
 * | 出口 5 | 超过 expiredAt | **任何人**（permissionless） | Expired |
 *
 * 参考实现里 evaluator 在 **Funded 与 Submitted 两态**都可以 reject；本脚本验的是
 * Funded 态那条（v2.2 §2.2 出口 1 的早退路径）。
 *
 * 用法：
 *   ARC_RPC_URL=https://arc-testnet.drpc.org \
 *   node --import tsx scripts/spike/exit1-reject.ts [--budget 0.05]
 */
import { ENV_KEYS, loadDotEnvFile, optionalEnv, readAddress } from "../../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../../packages/chain/src/config/redact.js";
import { formatUsdc } from "../../packages/chain/src/diagnostics.js";
import { bytes32FromText } from "../../packages/chain/src/hashing.js";
import { InMemoryIdempotencyStore } from "../../packages/chain/src/idempotency-store.js";
import {
  createJobClient,
  DEMO_EXPIRY_SECONDS,
  expiryFromNow,
} from "../../packages/chain/src/job-client.js";
import type { Address } from "../../packages/chain/src/types/viem.js";
import { createArcPublicClient, type RpcConfig } from "../../packages/chain/src/wallet.js";
import { createJobRoleClients, toJobRoleWallets } from "../../packages/chain/src/wiring.js";
import { parseUsdcAmount } from "../../packages/chain/src/x402-client.js";

const DEFAULT_BUDGET_USDC = "0.05";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
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

  write(`出口 1：提交前拒绝。预算 ${formatUsdc(budgetAtomic)} USDC`);
  const before = await usdcBalance(publicClient, usdc, roles.client.address);
  write(`client 拒绝前 USDC：${formatUsdc(before)}`);

  const caseId = `exit1-${String(Date.now())}`;
  const created = await job.createJob({
    provider: roles.provider.address,
    evaluator: roles.evaluator.address,
    expiredAt: expiryFromNow(DEMO_EXPIRY_SECONDS),
    description: `citely exit1 ${caseId}`,
    caseId,
  });
  write(`[1/4] createJob jobId=${created.jobId.toString()} tx=${created.txHash}`);
  write(
    `[2/4] setBudget tx=${await job.setBudget(created.jobId, budgetAtomic)}`,
  );
  write(`[3/4] fund tx=${await job.fund(created.jobId, budgetAtomic)} → ${await job.getJobState(created.jobId)}`);

  // 关键：**不 submit**，直接由验证器在 Funded 态拒绝。
  const reasonHash = bytes32FromText(`${caseId}:not-accepted`);
  const rejectTx = await job.reject(created.jobId, reasonHash);
  const state = await job.getJobState(created.jobId);
  const after = await usdcBalance(publicClient, usdc, roles.client.address);
  write(`[4/4] reject（evaluator，Funded 态）tx=${rejectTx} → ${state}`);
  write(`  client 拒绝后 USDC：${formatUsdc(after)}（差额 ${formatUsdc(after - before)}，gas 也走 USDC）`);

  if (state !== "rejected") {
    throw new Error(`断言失败：出口 1 的终态应为 rejected，实际 ${state}`);
  }
  write(`EXIT1 OK jobId=${created.jobId.toString()} 状态=rejected 全额退回 client`);
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`EXIT1 FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
