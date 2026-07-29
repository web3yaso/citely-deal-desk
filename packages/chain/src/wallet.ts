import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { redactSecrets, registerSecret } from "./config/redact.js";
import { ChainError } from "./errors.js";

/** 32 字节十六进制私钥。 */
export const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Arc Testnet（chainId 5042002）。
 *
 * 直接复用 viem 内置定义，不自造 chain 对象——自造会与
 * `@circle-fin/x402-batching` 内部的 `chain: "arcTestnet"` 形成两份可能漂移的事实源。
 */
export const ARC_TESTNET: Chain = arcTestnet;

/**
 * 钱包角色（§2.1 角色映射）。每把私钥物理分离，任何情况下不得互相复用。
 *
 * - `marketplace` = 8183 `client`：createJob / approve+fund / claimRefund
 * - `operator` = 8183 `provider`：setBudget / submit（也是 SA 的 EIP-712 签名者）
 * - `verifier` = 8183 `evaluator`：complete / reject
 * - `procurement` = 链下 x402 付款，不参与 8183
 */
export type WalletRole = "marketplace" | "operator" | "verifier" | "procurement";

export interface RpcConfig {
  /** 主 RPC。 */
  readonly primaryUrl: string;
  /** 备用 RPC；主 RPC 失败或限流时自动切换。 */
  readonly fallbackUrl?: string;
}

/** 一把私钥对应的一组独立 client。 */
export interface ChainClients {
  readonly role: WalletRole;
  readonly account: PrivateKeyAccount;
  readonly address: Address;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

/**
 * 单个 RPC 的重试次数。
 *
 * 只重试 1 次：真实故障模式是**限流**（`request limit reached`），不是毫秒级抖动——
 * 冲着同一个已经拒绝我们的端点重试两次纯属白等（实测 3 次请求耗掉 ~480ms），
 * 换一家立刻就通。留 1 次是给真正的瞬时抖动兜底。
 */
const PER_RPC_RETRY_COUNT = 1;

/**
 * 构造带降级能力的 transport：主 RPC 排在前，失败/限流时 viem 自动切备用。
 *
 * 公共 RPC `rpc.testnet.arc.network` 易限流（v2.2 §2.1b 实证），降级不是可选项。
 * `rank: false` 保证优先级固定按传入顺序，不因延迟测量把主备调换。
 *
 * 覆盖范围（已核对 viem `fallback` 源码的默认 `shouldThrow`）：只有
 * 交易被拒 / 用户拒签 / **合约 revert** 这几类**确定性**错误会直接抛出不降级；
 * 限流（HTTP 429、5xx、`-32005` 之类的 JSON-RPC error）都会切到下一家——
 * 这正是我们要的：revert 换个 RPC 也还是 revert，重试没意义。
 */
export function createArcTransport(rpc: RpcConfig): Transport {
  const urls = [rpc.primaryUrl, ...(rpc.fallbackUrl === undefined ? [] : [rpc.fallbackUrl])];
  return fallback(
    urls.map((url) => http(url, { retryCount: PER_RPC_RETRY_COUNT, timeout: 20_000 })),
    { rank: false, retryCount: 0 },
  );
}

/**
 * 校验私钥格式。不合法时抛出的错误里**不含**私钥本身。
 *
 * @param value - 原始值（可带或不带 `0x`）
 * @param label - 出错时用于指认是哪一把密钥（例如环境变量名）
 */
export function assertPrivateKey(value: string | undefined, label: string): Hex {
  const trimmed = value?.trim();
  const normalized =
    trimmed !== undefined && trimmed !== "" && !trimmed.startsWith("0x") ? `0x${trimmed}` : trimmed;
  if (normalized === undefined || normalized === "") {
    throw new ChainError(`${label} 缺失：请在 .env 中填入 32 字节十六进制私钥`);
  }
  if (!PRIVATE_KEY_PATTERN.test(normalized)) {
    throw new ChainError(`${label} 格式非法：必须是 0x 开头的 64 位十六进制字符（32 字节）`);
  }
  return normalized as Hex;
}

/**
 * 建一个只读 public client（不持私钥）。
 *
 * 只读探测与体检脚本用它——脚本不该为了读链上一个 view 而拿着任何密钥。
 *
 * @param rpc - 主/备 RPC
 */
export function createArcPublicClient(rpc: RpcConfig): PublicClient<Transport, Chain> {
  return createPublicClient({ chain: ARC_TESTNET, transport: createArcTransport(rpc) });
}

/**
 * 为**一把**私钥建立独立的 public/wallet client 对。
 *
 * 每个角色单独调用一次；调用方不得把返回的 client 跨角色共享。
 */
export function createChainClients(role: WalletRole, privateKey: Hex, rpc: RpcConfig): ChainClients {
  // 入口即登记：之后任何一次 redactSecrets 都会自动屏蔽这把私钥，
  // 不必指望每个 catch 块记得传参（redact.ts 的设计意图）。
  registerSecret(privateKey);
  registerSecret(privateKey.slice(2));

  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(privateKey);
  } catch (error: unknown) {
    // viem 报错可能回显整段 key，必须先脱敏再抛。
    const detail = redactSecrets(error instanceof Error ? error.message : String(error), privateKey);
    throw new ChainError(`${role} 私钥无法派生账户：${detail}`, {}, { cause: error });
  }

  const transport = createArcTransport(rpc);
  const publicClient = createPublicClient({ chain: ARC_TESTNET, transport });
  const walletClient = createWalletClient({ account, chain: ARC_TESTNET, transport });

  return { role, account, address: account.address, publicClient, walletClient };
}
