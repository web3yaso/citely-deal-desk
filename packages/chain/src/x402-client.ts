import { setTimeout as delay } from "node:timers/promises";

import { CHAIN_CONFIGS, GatewayClient } from "@circle-fin/x402-batching/client";
import type { Address, Hex } from "viem";

import { registerSecret } from "./config/redact.js";
import { ChainError, wrapChainError } from "./errors.js";
import type { DealInput, ModuleId, ModuleResponse } from "./types/module.js";
import type { X402Client } from "./types/x402.js";
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
 * 照录 msb-agent 实测（合约 §9）：最贵的 us-msb 单次 0.80 USDC，留出余量。
 */
export const MINIMUM_GATEWAY_BALANCE = 1_050_000n;

/** `gw.pay` 的返回形状（`PayResult` 的最小子集）。 */
export interface GatewayPayResult {
  readonly status: number;
  readonly data: unknown;
  /** 结算 ID；空字符串视为失败。 */
  readonly transaction: string;
}

/**
 * {@link GatewayClient} 的最小接口。
 *
 * 抽出接口是为了让 x402 的错误分支能在**零网络零私钥**下测——
 * 真实 GatewayClient 结构上满足它。
 */
export interface GatewayLike {
  readonly address: Address;
  getBalances(): Promise<{
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

  async function check(moduleId: ModuleId, dealInput: DealInput): Promise<ModuleResponse> {
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
    return response;
  }

  return { check };
}
