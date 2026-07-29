/**
 * 环境体检：逐项 ✅/❌，**绝不打印任何密钥值**（私钥只回报派生出的公开地址，
 * OpenAI key 只回报「是否设置」）。
 *
 * 检查项：五类链上密钥格式 / OpenAI 两项 / RPC 主备连通与 chainId /
 * 各钱包余额 / 采购钱包 Gateway 可用余额 / `GET /modules` 可达。
 *
 * 用法：`pnpm doctor`（= `node --import tsx scripts/doctor.ts`）。
 * 任一项 ❌ 时进程退出码为 1；每项独立捕获异常，一次跑出全部问题。
 */
import {
  ENV_KEYS,
  loadDotEnvFile,
  optionalEnv,
  readAddress,
  readPrivateKey,
} from "../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../packages/chain/src/config/redact.js";
import {
  checkOpenAiApiKey,
  checkOpenAiModel,
  checkPrivateKeyFormat,
  deriveAddress,
  describeBalances,
  formatCheckLine,
  formatUsdc,
  pendingCheck,
  runCheck,
  summarize,
  type HealthCheckLine,
} from "../packages/chain/src/diagnostics.js";
import { ARC_TESTNET, createArcPublicClient } from "../packages/chain/src/wallet.js";
import {
  ARC_TESTNET_USDC,
  createResilientGateway,
  MINIMUM_GATEWAY_BALANCE,
} from "../packages/chain/src/x402-client.js";

/**
 * 余额不足时给用户的完整命令——只说「不够」等于把人晾在原地。
 *
 * 钱包里有没有 USDC 决定了下一步是「去领水」还是「直接存」，两种情况说法不同。
 */
function depositHint(walletBalance: bigint, needed: bigint): string {
  const faucet =
    walletBalance >= needed
      ? ""
      : "请先到 https://faucet.circle.com 领 Arc Testnet USDC，然后";
  return `${faucet}运行 \`node --import tsx scripts/gateway-deposit.ts 1.50\` 把 USDC 存进 Gateway（到账需要几分钟，别等到演示现场再存）`;
}

/** 五类密钥：四把运行时 + 一把离线签名用。 */
const KEY_VARS = [
  ENV_KEYS.operatorKey,
  ENV_KEYS.verifierKey,
  ENV_KEYS.marketplaceKey,
  ENV_KEYS.procurementKey,
  ENV_KEYS.moduleAttesterKey,
] as const;

/** 需要查余额的四把运行时钱包（Module 认证密钥只离线签名，不上链）。 */
const BALANCE_VARS = [
  ENV_KEYS.operatorKey,
  ENV_KEYS.verifierKey,
  ENV_KEYS.marketplaceKey,
  ENV_KEYS.procurementKey,
] as const;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 查余额共用的一个带降级能力的 client。
 *
 * 公共 RPC 会限流（实测 `request limit reached`），逐项新建只连主 RPC 的 client
 * 等于自己把自己打限流——这里主备一起给，失败自动切。
 */
function balanceClient(): ReturnType<typeof createArcPublicClient> {
  const primaryUrl = optionalEnv(process.env, ENV_KEYS.rpcUrl);
  if (primaryUrl === undefined) {
    throw new Error(`未设置 ${ENV_KEYS.rpcUrl}`);
  }
  const fallbackUrl = optionalEnv(process.env, ENV_KEYS.rpcUrlFallback);
  return createArcPublicClient(
    fallbackUrl === undefined ? { primaryUrl } : { primaryUrl, fallbackUrl },
  );
}

function rpcCheck(varName: string, label: string): Promise<HealthCheckLine> {
  return runCheck(`${label}（${varName}）`, async () => {
    const url = optionalEnv(process.env, varName);
    if (url === undefined) {
      throw new Error("未设置");
    }
    // 主备各自单独打一次：用 fallback transport 会把备用 RPC 的故障掩盖掉。
    const chainId = await createArcPublicClient({ primaryUrl: url }).getChainId();
    if (chainId !== ARC_TESTNET.id) {
      throw new Error(`chainId ${String(chainId)} ≠ Arc Testnet ${String(ARC_TESTNET.id)}`);
    }
    return `连通，chainId ${String(chainId)}`;
  });
}

function balanceCheck(varName: string): Promise<HealthCheckLine> {
  return runCheck(`钱包余额 ${varName}`, async () => {
    const address = deriveAddress(process.env, varName);
    const client = balanceClient();
    // USDC_ADDRESS 还没回填时用 SDK 内置的 Arc Testnet USDC，别让这一栏空着：
    // 钱包 USDC 余额是「能不能存进 Gateway」的前提，用户现在就要看。
    const usdc =
      optionalEnv(process.env, ENV_KEYS.usdc) === undefined
        ? ARC_TESTNET_USDC
        : readAddress(process.env, ENV_KEYS.usdc, "Arc Testnet USDC");
    return describeBalances(client, address, usdc);
  });
}

/** 地址类配置：填了就校验，没填标 ⏳（等 spike ①），不算失败。 */
function addressConfigCheck(varName: string, pendingReason: string): HealthCheckLine {
  if (optionalEnv(process.env, varName) === undefined) {
    return pendingCheck(varName, pendingReason);
  }
  try {
    return {
      name: varName,
      status: "ok",
      detail: readAddress(process.env, varName, pendingReason),
    };
  } catch (error: unknown) {
    return { name: varName, status: "fail", detail: safeErrorMessage(error) };
  }
}

function gatewayCheck(): Promise<HealthCheckLine> {
  return runCheck("采购钱包 Gateway 可用余额", async () => {
    const key = readPrivateKey(process.env, ENV_KEYS.procurementKey);
    // GatewayClient 只收一个 RPC，自身没有降级能力；createResilientGateway 会先预检选路，
    // 读余额撞上限流时再换一家重来——体检前面已经在主 RPC 上打了十来次调用，很容易触发。
    const primaryUrl = optionalEnv(process.env, ENV_KEYS.rpcUrl);
    if (primaryUrl === undefined) {
      throw new Error(`未设置 ${ENV_KEYS.rpcUrl}`);
    }
    const fallbackUrl = optionalEnv(process.env, ENV_KEYS.rpcUrlFallback);
    const { gateway } = await createResilientGateway(
      key,
      fallbackUrl === undefined ? { primaryUrl } : { primaryUrl, fallbackUrl },
    );
    const { gateway: balance, wallet } = await gateway.getBalances();
    // 与上面的「钱包余额」行是两个不同的量：钱包里有 USDC ≠ 能付 x402。
    if (balance.available < MINIMUM_GATEWAY_BALANCE) {
      throw new Error(
        `${formatUsdc(balance.available)} USDC < 门槛 ${formatUsdc(MINIMUM_GATEWAY_BALANCE)} USDC` +
          `（同一钱包里还有 ${formatUsdc(wallet.balance)} USDC 未存入 Gateway）。` +
          depositHint(wallet.balance, MINIMUM_GATEWAY_BALANCE),
      );
    }
    return `${formatUsdc(balance.available)} USDC ≥ 门槛 ${formatUsdc(MINIMUM_GATEWAY_BALANCE)} USDC`;
  });
}

function modulesCheck(): Promise<HealthCheckLine> {
  return runCheck(`GET /modules（${ENV_KEYS.msbAgentBaseUrl}）`, async () => {
    const baseUrl = optionalEnv(process.env, ENV_KEYS.msbAgentBaseUrl);
    if (baseUrl === undefined) {
      throw new Error("未设置");
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/modules`);
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    const body: unknown = await response.json();
    const modules =
      typeof body === "object" && body !== null && "modules" in body
        ? (body as { modules: unknown }).modules
        : undefined;
    if (!Array.isArray(modules) || modules.length === 0) {
      throw new Error("响应里没有 modules 数组");
    }
    return `可达，${String(modules.length)} 个 module`;
  });
}

async function collect(): Promise<HealthCheckLine[]> {
  const lines: HealthCheckLine[] = KEY_VARS.map((name) => checkPrivateKeyFormat(process.env, name));
  lines.push(checkOpenAiApiKey(process.env), checkOpenAiModel(process.env));
  lines.push(await rpcCheck(ENV_KEYS.rpcUrl, "主 RPC"));
  lines.push(await rpcCheck(ENV_KEYS.rpcUrlFallback, "备用 RPC"));
  for (const name of BALANCE_VARS) {
    lines.push(await balanceCheck(name));
  }
  lines.push(await gatewayCheck());
  lines.push(
    // spike ① 已出结论并真链裸调通过，这两个值现在都有确定来源，缺的只是回填。
    addressConfigCheck(
      ENV_KEYS.jobContract,
      "未填；spike ① 已核实可用部署 0x0747EEf0706327138c69792bF28Cd525089e4583，可直接回填",
    ),
    addressConfigCheck(ENV_KEYS.usdc, `未填；链上 paymentToken() 读出 ${ARC_TESTNET_USDC}，可直接回填`),
    addressConfigCheck(ENV_KEYS.gatewayWallet, "Circle Gateway Wallet 合约地址"),
  );
  lines.push(await modulesCheck());
  return lines;
}

async function main(): Promise<void> {
  const loaded = loadDotEnvFile(new URL("../.env", import.meta.url).pathname);
  write(loaded ? "已加载仓库根 .env" : "未找到仓库根 .env，改用当前进程环境变量");
  const lines = await collect();
  for (const line of lines) {
    write(formatCheckLine(line));
  }
  const { passed, failed, pending, ok } = summarize(lines);
  write(
    `\n体检结果：${String(passed)} 通过 / ${String(failed)} 失败 / ${String(pending)} 待上游（⏳ 不算失败）`,
  );
  if (!ok) {
    process.exitCode = 1;
  }
}

await main();
