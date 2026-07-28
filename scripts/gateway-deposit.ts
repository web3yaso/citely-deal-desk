/**
 * 把**采购钱包**的 Arc Testnet USDC 存进 Circle Gateway。**手动执行，不进 CI。**
 *
 * 为什么需要它：x402 付款花的是 **Gateway 可用余额**，不是钱包 USDC 余额；
 * 存款到账是**分钟级**，演示现场现存必翻车（合约 §8）。所以必须提前跑一次。
 *
 * 只接受 `PROCUREMENT_PRIVATE_KEY`——三密钥物理分离，采购钱包不碰 8183，
 * 另外四把密钥在这里一律不可用。
 *
 * 用法：
 *   node --import tsx scripts/gateway-deposit.ts [金额] [--force]
 *   金额缺省取 `SMOKE_DEPOSIT_USDC`，再缺省为 1.50（小额，不写死大额）。
 *   余额已达门槛时直接退出；确实要追加存款才加 `--force`。
 */
import { ENV_KEYS, loadDotEnvFile, optionalEnv, readPrivateKey } from "../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../packages/chain/src/config/redact.js";
import { formatUsdc } from "../packages/chain/src/diagnostics.js";
import {
  createGatewayClient,
  DEPOSIT_POLL_INTERVAL_MS,
  DEPOSIT_POLL_MAX_ATTEMPTS,
  MINIMUM_GATEWAY_BALANCE,
  parseUsdcAmount,
  waitForGatewayDeposit,
} from "../packages/chain/src/x402-client.js";

/** 缺省存款额：够跑几次最贵的 us-msb（0.80 USDC/次），又不至于一次锁太多。 */
const DEFAULT_DEPOSIT_USDC = "1.50";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 取金额：命令行第一个非 flag 参数 > `SMOKE_DEPOSIT_USDC` > 缺省。 */
function resolveAmount(argv: readonly string[]): string {
  const positional = argv.find((arg) => !arg.startsWith("--"));
  return positional ?? optionalEnv(process.env, "SMOKE_DEPOSIT_USDC") ?? DEFAULT_DEPOSIT_USDC;
}

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../.env", import.meta.url).pathname);
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const amount = resolveAmount(argv);
  const amountAtomic = parseUsdcAmount(amount);

  const gateway = createGatewayClient(
    readPrivateKey(process.env, ENV_KEYS.procurementKey),
    optionalEnv(process.env, ENV_KEYS.rpcUrl),
  );
  write(`采购钱包地址（请人工核对）：${gateway.address}`);

  write("[1/3] 查询余额");
  const before = await gateway.getBalances();
  write(`  钱包 USDC 余额     ：${formatUsdc(before.wallet.balance)} USDC`);
  write(`  Gateway 可用余额   ：${formatUsdc(before.gateway.available)} USDC（x402 付款花的是这个）`);
  write(`  门槛               ：${formatUsdc(MINIMUM_GATEWAY_BALANCE)} USDC`);

  if (before.gateway.available >= MINIMUM_GATEWAY_BALANCE && !force) {
    write("[2/3] 跳过存款：Gateway 可用余额已达门槛。确需追加请加 --force。");
    write("GATEWAY-DEPOSIT OK（未存款）");
    return;
  }
  if (before.wallet.balance < amountAtomic) {
    throw new Error(
      `钱包 USDC 余额 ${formatUsdc(before.wallet.balance)} 不足以存入 ${amount}：` +
        "请先到 https://faucet.circle.com 领 Arc Testnet USDC",
    );
  }

  write(`[2/3] 存入 ${amount} USDC（approve + deposit）`);
  const deposit = await gateway.deposit(amount);
  write(`  deposit txHash：${deposit.depositTxHash}`);

  const expected = before.gateway.available + amountAtomic;
  write(
    `[3/3] 等待到账：每 ${String(DEPOSIT_POLL_INTERVAL_MS / 1000)} 秒查一次，` +
      `最多 ${String(DEPOSIT_POLL_MAX_ATTEMPTS)} 次（约 ${String((DEPOSIT_POLL_INTERVAL_MS * DEPOSIT_POLL_MAX_ATTEMPTS) / 60_000)} 分钟）`,
  );
  const available = await waitForGatewayDeposit(gateway, expected, {
    onProgress: (attempt, maxAttempts, current) => {
      write(
        `  ${String(attempt)}/${String(maxAttempts)}：Gateway 可用余额 ${formatUsdc(current)} USDC`,
      );
    },
  });
  write(`GATEWAY-DEPOSIT OK：Gateway 可用余额 ${formatUsdc(available)} USDC`);
}

try {
  await main();
} catch (error: unknown) {
  // 私钥在 readPrivateKey 时已登记，SDK 报错回显私钥也会被这里替换掉。
  process.stderr.write(`GATEWAY-DEPOSIT FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
