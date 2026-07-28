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
 * 五个写函数的裸调**不在本轮**：没有可用部署就无从调起。若结论是 NO_CODE，
 * 部署方案（UUPS + ERC1967 代理 + `initialize`）先报主导批准，执行永远由用户来。
 * 本脚本**不需要任何私钥**——只读探测不该持有密钥。
 *
 * 用法：`node --import tsx scripts/spike/8183-bare-calls.ts [--address 0x...]`
 * 地址优先级：`--address` > 环境变量 `JOB_CONTRACT_ADDRESS`。
 */
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

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../../.env", import.meta.url).pathname);
  const address = resolveContractAddress(
    process.argv.slice(2),
    optionalEnv(process.env, "JOB_CONTRACT_ADDRESS"),
  );
  const client = createArcPublicClient({
    primaryUrl: optionalEnv(process.env, "ARC_RPC_URL") ?? DEFAULT_RPC,
    fallbackUrl: optionalEnv(process.env, "ARC_RPC_URL_FALLBACK") ?? DEFAULT_RPC_FALLBACK,
  });

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
}

try {
  await main();
} catch (error: unknown) {
  // 只读脚本不持私钥，仍统一过 redact：RPC 报错可能回显整段请求。
  process.stderr.write(`SPIKE-8183 FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
