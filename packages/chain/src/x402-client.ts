import { setTimeout as delay } from "node:timers/promises";

import { CHAIN_CONFIGS, GatewayClient } from "@circle-fin/x402-batching/client";
import type { Address, Hex } from "viem";

import { registerSecret } from "./config/redact.js";
import { ChainError, wrapChainError } from "./errors.js";
import { createArcPublicClient, type RpcConfig } from "./wallet.js";
import type { DealInput, ModuleId, ModuleResponse } from "./types/module.js";
import type { ModuleCheckResult, X402Client } from "./types/x402.js";
import { assertModuleResponse } from "./validate/module-response.js";

/**
 * Arc Testnet USDC（8183 的 `paymentToken`，也是 x402 报价单里的 `asset`）。
 *
 * 取自 SDK 内置配置而不是抄一份常量：抄一份就多一个会漂移的事实源。
 */
export const ARC_TESTNET_USDC: Address = CHAIN_CONFIGS.arcTestnet.usdc;

/** Circle Gateway Wallet 合约（EIP-3009 的 verifyingContract，**不是** USDC 合约）。 */
export const ARC_TESTNET_GATEWAY_WALLET: Address = CHAIN_CONFIGS.arcTestnet.gatewayWallet;

/**
 * Gateway 可用余额门槛（原子单位，1.05 USDC）。
 *
 * 门槛设 1.05 是为了覆盖**当前最贵的单次采购**。原注释写的"最贵的 us-msb 单次
 * 0.80 USDC"已不成立：2026-08 上线的 `ae-msb` 单价 1.000000 USDC，是现在最贵的一个。
 *
 * 数值**刻意不上调**：1.05 仍 ≥ 最贵单价，单次采购不会被误拒。但余量只剩 0.05——
 * 跑一次 ae-msb 后余额净减 1.00，**连跑两案需要起始可用余额 ≥ 2.05 USDC**，
 * 否则第二次会在这里响亮失败（不是静默降级）。这是运维前置条件，不是代码问题。
 */
export const MINIMUM_GATEWAY_BALANCE = 1_050_000n;

/** `gw.pay` 的返回形状（`PayResult` 的最小子集）。 */
export interface GatewayPayResult {
  readonly status: number;
  readonly data: unknown;
  /** 结算 ID；空字符串视为失败。账本 `ref_type="gateway_receipt"` 的 `ref` 值。 */
  readonly transaction: string;
  /** 实付金额，6 位小数原子单位。账本按实付记，不按定价表推算。 */
  readonly amount: bigint;
}

/**
 * {@link GatewayClient} 的最小接口。
 *
 * 抽出接口是为了让 x402 的错误分支能在**零网络零私钥**下测——
 * 真实 GatewayClient 结构上满足它。
 */
export interface GatewayLike {
  readonly address: Address;
  /**
   * 钱包余额与 Gateway 余额是**两个不同的量**：x402 付款花的是
   * `gateway.available`，钱包里有 USDC 不等于付得了款。两个都要，别只读一个。
   */
  getBalances(): Promise<{
    readonly wallet: { readonly balance: bigint; readonly formatted: string };
    readonly gateway: { readonly available: bigint; readonly formattedAvailable: string };
  }>;
  pay(
    url: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<GatewayPayResult>;
}

/** 存款到账轮询间隔（毫秒）。Gateway 到账是分钟级，照录 msb-agent 实测值。 */
export const DEPOSIT_POLL_INTERVAL_MS = 15_000;

/** 存款到账轮询次数上限（15s × 24 = 6 分钟）。 */
export const DEPOSIT_POLL_MAX_ATTEMPTS = 24;

const USDC_AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

/**
 * 十进制 USDC 金额字符串 → 6 位小数原子单位。
 *
 * 不用 `Number` 转：浮点会把 `0.1 + 0.2` 变成 `0.30000000000000004`，钱的换算不能碰浮点。
 *
 * @param raw - 形如 `"1.5"` 的正数，最多 6 位小数
 * @returns 原子单位
 */
export function parseUsdcAmount(raw: string): bigint {
  const amount = raw.trim();
  if (!USDC_AMOUNT_PATTERN.test(amount)) {
    throw new ChainError(`USDC 金额必须是正数且最多 6 位小数：${raw}`);
  }
  const [whole = "0", fraction = ""] = amount.split(".");
  const atomic = BigInt(`${whole}${fraction.padEnd(6, "0")}`);
  if (atomic <= 0n) {
    throw new ChainError(`USDC 金额必须大于 0：${raw}`);
  }
  return atomic;
}

/** 只需要查余额的最小接口，方便测试注入。 */
export type GatewayBalanceSource = Pick<GatewayLike, "getBalances">;

export interface WaitForDepositOptions {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  /** 每次轮询后回调，供脚本打印进度。 */
  readonly onProgress?: (attempt: number, maxAttempts: number, available: bigint) => void;
}

/**
 * 轮询等待 Gateway 存款到账（可用余额涨到 `expectedAvailable`）。
 *
 * 轮询不订阅（架构不变量）；超时抛出说清等了多久的 {@link ChainError}。
 *
 * @param gateway - 余额来源
 * @param expectedAvailable - 期望达到的可用余额（存款前余额 + 存入额）
 * @param options - 间隔 / 次数 / 进度回调
 * @returns 到账后的可用余额
 */
export async function waitForGatewayDeposit(
  gateway: GatewayBalanceSource,
  expectedAvailable: bigint,
  options: WaitForDepositOptions = {},
): Promise<bigint> {
  const intervalMs = options.intervalMs ?? DEPOSIT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEPOSIT_POLL_MAX_ATTEMPTS;
  let available = 0n;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await delay(intervalMs);
    available = (await gateway.getBalances()).gateway.available;
    options.onProgress?.(attempt, maxAttempts, available);
    if (available >= expectedAvailable) {
      return available;
    }
  }
  throw new ChainError(
    `存款等待超时：${String((intervalMs * maxAttempts) / 1000)} 秒内 Gateway 可用余额` +
      `未达到 ${expectedAvailable.toString()}（最后一次为 ${available.toString()}，原子单位）。` +
      "资金没有丢，稍后再查一次余额即可。",
  );
}

export interface X402ClientDeps {
  /** msb-agent 基址，例如 `https://msb-agent-production-769d.up.railway.app`。 */
  readonly baseUrl: string;
  readonly gateway: GatewayLike;
  /** 余额门槛，默认 {@link MINIMUM_GATEWAY_BALANCE}。 */
  readonly minimumBalance?: bigint;
}

/**
 * 用**采购钱包**私钥建 GatewayClient（三密钥物理分离：不得复用运营/验证器密钥）。
 *
 * @param privateKey - `PROCUREMENT_PRIVATE_KEY`
 * @param rpcUrl - 可选自定义 RPC
 */
export function createGatewayClient(privateKey: Hex, rpcUrl?: string): GatewayClient {
  registerSecret(privateKey);
  return new GatewayClient({
    chain: "arcTestnet",
    privateKey,
    ...(rpcUrl === undefined || rpcUrl === "" ? {} : { rpcUrl }),
  });
}

/** 限流的几种说法。公共 RPC 实测回 `request limit reached`，其余是常见同类措辞。 */
const RATE_LIMIT_PATTERNS = [
  /request limit reached/i,
  /rate ?limit/i,
  /too many requests/i,
  /\b429\b/,
  /-32005/,
];

/**
 * 判断一个错误是不是「连上了但被拒」——限流，而不是「连不上」。
 *
 * 两者要分开处理：限流换一家 RPC 立刻通，`revert` 换一家还是 `revert`。
 * 这里只认限流，别的错误一律原样抛出，不许拿"重试一下"掩盖真问题。
 *
 * @param error - catch 到的值
 */
export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

/** 带降级能力的 Gateway 客户端（比 {@link GatewayLike} 多一个存款方法）。 */
export interface ResilientGateway extends GatewayLike {
  deposit(amount: string): Promise<{ readonly depositTxHash: Hex }>;
}

export interface ResilientGatewayOptions {
  /** 客户端工厂。默认建真的 {@link GatewayClient}；测试注入假的，零网络零私钥。 */
  readonly buildGateway?: (privateKey: Hex, rpcUrl: string) => ResilientGateway;
  /** 预检探针，默认打一次 `eth_chainId`。 */
  readonly probe?: (url: string) => Promise<number>;
}

export interface ResilientGatewayResult {
  readonly gateway: ResilientGateway;
  /** 实际选中的 RPC。 */
  readonly rpcUrl: string;
  /** 是否已经退到备用 RPC（主 RPC 预检没过）。 */
  readonly degraded: boolean;
}

/** 预检：拿 `eth_chainId` 探一下，返回第一个活着的 RPC。 */
export async function pickHealthyRpcUrl(
  rpc: RpcConfig,
  probe: (url: string) => Promise<number> = defaultProbe,
): Promise<{ readonly rpcUrl: string; readonly degraded: boolean }> {
  try {
    await probe(rpc.primaryUrl);
    return { rpcUrl: rpc.primaryUrl, degraded: false };
  } catch (error: unknown) {
    if (rpc.fallbackUrl === undefined) {
      throw wrapChainError(error, `主 RPC 不可用且未配置备用 RPC（${rpc.primaryUrl}）`);
    }
    await probe(rpc.fallbackUrl);
    return { rpcUrl: rpc.fallbackUrl, degraded: true };
  }
}

async function defaultProbe(url: string): Promise<number> {
  return createArcPublicClient({ primaryUrl: url }).getChainId();
}

/**
 * 建一个对限流有抵抗力的 Gateway 客户端。
 *
 * `GatewayClient` 只收**一个** `rpcUrl`，viem 的 fallback transport 覆盖不到它，
 * 所以降级必须在调用层做，分两道：
 *
 * 1. **预检选路**：建客户端之前先探一次 chainId，主 RPC 已经限流就直接用备用；
 * 2. **读操作故障转移**：`getBalances` 撞上限流时换另一个 URL 重来一次。
 *
 * ⚠️ **写操作（`deposit` / `pay`）故意不做事后自动重试**：限流可能发生在交易已经广播
 * 之后，盲目换个 RPC 重试有重复存款/重复付款的风险。写操作靠第 1 道预检把住，
 * 真撞上了就带着可操作的提示抛出来，由人决定。
 *
 * @param privateKey - `PROCUREMENT_PRIVATE_KEY`
 * @param rpc - 主/备 RPC
 */
export async function createResilientGateway(
  privateKey: Hex,
  rpc: RpcConfig,
  options: ResilientGatewayOptions = {},
): Promise<ResilientGatewayResult> {
  const build = options.buildGateway ?? ((key, url) => createGatewayClient(key, url));
  const { rpcUrl, degraded } = await pickHealthyRpcUrl(
    rpc,
    ...(options.probe === undefined ? [] : ([options.probe] as const)),
  );
  const otherUrl = rpcUrl === rpc.primaryUrl ? rpc.fallbackUrl : rpc.primaryUrl;
  const selected = build(privateKey, rpcUrl);
  const spare = otherUrl === undefined ? undefined : () => build(privateKey, otherUrl);

  const gateway: ResilientGateway = {
    address: selected.address,
    getBalances: async () => {
      try {
        return await selected.getBalances();
      } catch (error: unknown) {
        if (spare === undefined || !isRateLimitError(error)) {
          throw wrapChainError(error, "查询 Gateway 余额失败");
        }
        // 纯读操作，换一家重来一次没有任何副作用。
        return spare().getBalances();
      }
    },
    // 写操作只包错误、不自动换 RPC 重试：限流可能发生在交易已广播之后。
    pay: async (url, options) => writeGuard("x402 付款", rpcUrl, otherUrl, () => selected.pay(url, options)),
    deposit: async (amount) => writeGuard("Gateway 存款", rpcUrl, otherUrl, () => selected.deposit(amount)),
  };
  return { gateway, rpcUrl, degraded };
}

/**
 * 写操作的限流护栏：不自动重试，但把「换哪个 RPC 重跑」这句可操作的话说清楚。
 *
 * 自动重试写操作 = 可能重复付款；让人看着提示重跑一次是更安全的默认。
 */
async function writeGuard<T>(
  what: string,
  usedUrl: string,
  spareUrl: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (!isRateLimitError(error)) {
      throw wrapChainError(error, `${what}失败`);
    }
    const hint =
      spareUrl === undefined
        ? "未配置备用 RPC（ARC_RPC_URL_FALLBACK），请稍后重试"
        : `请用 ARC_RPC_URL=${spareUrl} 重跑一次`;
    throw wrapChainError(
      error,
      `${what}撞上 RPC 限流（${usedUrl}）。写操作不自动换 RPC 重试` +
        `（可能已经广播，重试有重复扣款风险）——${hint}`,
    );
  }
}

function assertSufficientBalance(available: bigint, formatted: string, minimum: bigint): void {
  if (available >= minimum) {
    return;
  }
  // 绝不自动 deposit：到账分钟级，演示现场现存款必翻车（合约 §8），
  // 而且自动花钱的客户端不该由判定链路持有。
  throw new ChainError(
    `采购钱包 Gateway 可用余额不足：当前 ${formatted} USDC，` +
      `至少需要 ${(Number(minimum) / 1e6).toFixed(2)} USDC。` +
      "请先到 https://faucet.circle.com 领 Arc Testnet USDC，再运行 " +
      "`node --import tsx scripts/gateway-deposit.ts 1.50`（到账需要几分钟）" +
      "——本客户端不会自动存款。",
  );
}

function assertPaid(result: GatewayPayResult, endpoint: string): void {
  if (result.status !== 200) {
    throw new ChainError(
      `x402 付费请求应返回 200，实际 ${String(result.status)}（${endpoint}）：` +
        JSON.stringify(result.data),
    );
  }
  if (result.transaction === "") {
    throw new ChainError(`x402 付费请求缺少结算 ID（${endpoint}）：视为付款失败`);
  }
}

function assertMatchesRequest(
  response: ModuleResponse,
  moduleId: ModuleId,
  dealInput: DealInput,
): void {
  if (response.module !== moduleId) {
    throw new ChainError(`Module 响应的 module=${response.module} 与请求的 ${moduleId} 不一致`);
  }
  const dealId = response.settlement_constraints.deal_id;
  if (dealId !== dealInput.deal_id) {
    throw new ChainError(
      `Module 响应的 settlement_constraints.deal_id=${dealId} 与请求的 ${dealInput.deal_id} 不一致`,
    );
  }
}

/**
 * 创建 x402 采购客户端：402 → 签名付款 → 重放 → 200 一体（合约 §9）。
 *
 * @param deps - 基址、Gateway 客户端、余额门槛
 */
export function createX402Client(deps: X402ClientDeps): X402Client {
  const baseUrl = deps.baseUrl.replace(/\/$/, "");
  const minimum = deps.minimumBalance ?? MINIMUM_GATEWAY_BALANCE;

  async function check(moduleId: ModuleId, dealInput: DealInput): Promise<ModuleCheckResult> {
    const endpoint = `${baseUrl}/modules/${moduleId}/check`;
    const balances = await deps.gateway.getBalances();
    assertSufficientBalance(balances.gateway.available, balances.gateway.formattedAvailable, minimum);

    let result: GatewayPayResult;
    try {
      result = await deps.gateway.pay(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // body 传对象，不是字符串（合约 §9 实测）。
        body: dealInput,
      });
    } catch (error: unknown) {
      throw wrapChainError(error, `x402 付款失败（${endpoint}）`);
    }

    assertPaid(result, endpoint);
    const response = assertModuleResponse(result.data);
    assertMatchesRequest(response, moduleId, dealInput);
    // 结算 ID 与实付金额一并透出：账本的 gateway_receipt 一态只有这里能拿到数据。
    return { response, settlementId: result.transaction, paidAtomic: result.amount };
  }

  return { check };
}
