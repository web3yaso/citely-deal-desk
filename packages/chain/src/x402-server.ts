import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, Price } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Address } from "viem";

import { ENV_KEYS, optionalEnv, readAddress, readUrl, type EnvSource } from "./config/env.js";
import { ChainError, wrapChainError } from "./errors.js";
import { PaidRetryStore, paymentCredentialId, paymentRetryKey } from "./paid-retry.js";
import { ARC_TESTNET_GATEWAY_WALLET, ARC_TESTNET_USDC, parseUsdcAmount } from "./x402-client.js";

/** Arc Testnet 的 CAIP-2 网络标识（chainId 5042002）。 */
export const ARC_TESTNET_NETWORK: Network = "eip155:5042002";

/**
 * Arc Testnet 报价单的 `extra`（EIP-712 域）。
 *
 * 照录 Circle hosted facilitator `GET /supported` 里 `eip155:5042002 exact` 的声明：
 * 签的是 **GatewayWalletBatched** 合约，不是 USDC 合约（合约 §8）。
 * 地址一律小写，与 facilitator 广告的字面值逐字一致。
 */
export const ARC_GATEWAY_BATCHED_EXTRA = {
  minValiditySeconds: 604_800,
  name: "GatewayWalletBatched",
  verifyingContract: ARC_TESTNET_GATEWAY_WALLET.toLowerCase(),
  version: "1",
} as const;

/** 卖方定价上限（原子单位，100 USDC）。挡住把 `1.00` 打成 `100.00` 这类手滑。 */
export const MAX_SELL_PRICE_ATOMIC = 100_000_000n;

/** 卖方收费开关。`off` = 不收费（本地联调用），线上一律 `x402-arc-testnet`。 */
export type SellerPaymentMode = "off" | "x402-arc-testnet";

/** 已开启收费时的完整卖方配置。 */
export interface ActiveSellerPaymentConfig {
  readonly mode: "x402-arc-testnet";
  readonly facilitatorUrl: string;
  /** 收款地址（USDC 进这里）。 */
  readonly payTo: Address;
  /** 单价，6 位小数原子单位的十进制字符串。 */
  readonly priceAtomic: string;
  /** 本服务的公网基址，用来拼报价单里的 `resource`。 */
  readonly publicBaseUrl: string;
}

/** 卖方配置：判别联合，`off` 分支上不存在定价字段，调用方必须显式处理。 */
export type SellerPaymentConfig = { readonly mode: "off" } | ActiveSellerPaymentConfig;

/** 未显式配置时的默认单价（USDC）。 */
export const DEFAULT_SELL_PRICE_USDC = "1.00";

function readSellMode(env: EnvSource): SellerPaymentMode {
  const raw = optionalEnv(env, ENV_KEYS.sellMode) ?? "x402-arc-testnet";
  if (raw !== "off" && raw !== "x402-arc-testnet") {
    throw new ChainError(
      `环境变量 ${ENV_KEYS.sellMode} 只能是 off 或 x402-arc-testnet，实际：${raw}`,
    );
  }
  return raw;
}

function readSellPriceAtomic(env: EnvSource): string {
  const raw = optionalEnv(env, ENV_KEYS.sellPriceUsdc) ?? DEFAULT_SELL_PRICE_USDC;
  const atomic = parseUsdcAmount(raw);
  if (atomic > MAX_SELL_PRICE_ATOMIC) {
    throw new ChainError(
      `环境变量 ${ENV_KEYS.sellPriceUsdc}=${raw} 超过单次收费上限 ` +
        `${(Number(MAX_SELL_PRICE_ATOMIC) / 1e6).toFixed(2)} USDC`,
    );
  }
  return atomic.toString();
}

/**
 * 从环境变量加载卖方收费配置。
 *
 * 付费模式下任何一项缺失都立刻抛错——半配置的收费服务会静默免费提供服务。
 *
 * @param env - 环境变量来源，默认 `process.env`
 */
export function loadSellerPaymentConfig(env: EnvSource = process.env): SellerPaymentConfig {
  const mode = readSellMode(env);
  if (mode === "off") {
    return { mode };
  }
  return {
    mode,
    facilitatorUrl: readUrl(env, ENV_KEYS.facilitatorUrl, "Circle x402 facilitator 地址"),
    payTo: readAddress(env, ENV_KEYS.sellPayTo, "卖出判定的 USDC 收款地址"),
    priceAtomic: readSellPriceAtomic(env),
    publicBaseUrl: readUrl(env, ENV_KEYS.publicBaseUrl, "本服务的公网基址（Railway 域名）"),
  };
}

/**
 * 构造 Arc Testnet 报价单价格。
 *
 * Arc 上不能用 `"$1.00"` 这种 Money 写法：facilitator 只认带
 * {@link ARC_GATEWAY_BATCHED_EXTRA} 域的 AssetAmount。
 *
 * @param config - 已开启收费的卖方配置
 */
export function createSellPrice(config: ActiveSellerPaymentConfig): Price {
  return {
    amount: config.priceAtomic,
    asset: ARC_TESTNET_USDC,
    extra: { ...ARC_GATEWAY_BATCHED_EXTRA },
  };
}

/** 一条收费路由的规格（工厂的入参）。 */
export interface PaidRouteSpec {
  readonly config: ActiveSellerPaymentConfig;
  /** 路由路径，例如 `/deals/review`。只保护 POST。 */
  readonly path: string;
  /** 报价单里的 `resource`，公网可达的完整 URL。 */
  readonly resource: string;
  /** 报价单里的人类可读描述。 */
  readonly description: string;
}

/** x402 中间件工厂。默认打真 facilitator；测试注入假的，零网络零私钥。 */
export type SellerMiddlewareFactory = (spec: PaidRouteSpec) => MiddlewareHandler;

/** 默认工厂：Circle hosted facilitator + EVM exact scheme。 */
export function createSellerMiddleware(spec: PaidRouteSpec): MiddlewareHandler {
  const facilitatorClient = new HTTPFacilitatorClient({ url: spec.config.facilitatorUrl });
  return paymentMiddlewareFromConfig(
    {
      [`POST ${spec.path}`]: {
        accepts: {
          network: ARC_TESTNET_NETWORK,
          payTo: spec.config.payTo,
          price: createSellPrice(spec.config),
          scheme: "exact",
        },
        description: spec.description,
        mimeType: "application/json",
        resource: spec.resource,
      },
    },
    facilitatorClient,
    [{ network: ARC_TESTNET_NETWORK, server: new ExactEvmScheme() }],
  );
}

/**
 * 读请求里的支付凭证。
 *
 * 两个头都认：`payment-signature` 是 Circle Gateway 客户端发的，`x-payment` 是 x402 标准头。
 */
export function readPaymentCredential(request: Request): string | undefined {
  return request.headers.get("payment-signature") ?? request.headers.get("x-payment") ?? undefined;
}

/**
 * 取可安全回显的凭证标识（哈希），给宿主服务写进响应/账本用。
 *
 * 宿主不该自己再哈希一遍：哈希口径必须和幂等键的口径是同一个。
 *
 * @param request - 已通过收费闸的请求
 */
export function readPaymentCredentialId(request: Request): string | undefined {
  const credential = readPaymentCredential(request);
  return credential === undefined ? undefined : paymentCredentialId(credential);
}

async function readRetryKey(request: Request, path: string): Promise<string | undefined> {
  const credential = readPaymentCredential(request);
  if (credential === undefined) {
    return undefined;
  }
  // clone 一份读 body：原请求体后面还要交给业务 handler。
  const body = await request.clone().text();
  return paymentRetryKey(paymentCredentialId(credential), path, body);
}

export interface PaidRouteOptions extends Omit<PaidRouteSpec, "resource"> {
  /** 已付款重试记忆。多条收费路由应共用同一个实例。 */
  readonly retryStore?: PaidRetryStore;
  readonly factory?: SellerMiddlewareFactory;
  /**
   * 收款/结算失败时的上报钩子。
   *
   * 中间件不打日志（chain 包不持有 logger），但也不吞错：一律包成
   * {@link ChainError} 交给宿主服务落日志。
   */
  readonly onError?: (error: ChainError) => void;
}

interface PaidRequestRun {
  readonly context: Context;
  readonly next: Next;
  readonly x402: MiddlewareHandler;
  readonly retryStore: PaidRetryStore;
  readonly retryKey: string | undefined;
  /** 出错消息里带上路径，便于对账时定位是哪条收费路由。 */
  readonly path: string;
  readonly onError: (error: ChainError) => void;
}

/**
 * 跑一次收费请求：验款 → 业务 → 按结果决定是否记住"已付款"。
 *
 * 记住的时机只有两种，都发生在**钱已经收了而我们没交付**时：
 * facilitator 之后的处理抛错、或业务返回 5xx。此时客户拿同一张凭证重试不再计费。
 */
async function runPaidRequest(run: PaidRequestRun): Promise<Response | undefined> {
  let paid = false;
  try {
    const response = await run.x402(run.context, async () => {
      paid = true;
      await run.next();
    });
    if (response instanceof Response) {
      run.context.res = response;
    }
  } catch (error: unknown) {
    const wrapped = wrapChainError(error, `x402 收款链路失败（${run.path}）`);
    run.onError(wrapped);
    if (!paid) {
      // 还没收到钱：facilitator 不可用不是客户的错，回 502 让它稍后重试。
      return run.context.json(
        { error: "facilitator_unavailable", message: "支付服务暂不可用，请稍后重试" },
        502,
      );
    }
    rememberPaid(run);
    throw wrapped;
  }
  if (paid && run.context.res.status >= 500) {
    rememberPaid(run);
  }
  return undefined;
}

function rememberPaid(run: PaidRequestRun): void {
  if (run.retryKey !== undefined) {
    run.retryStore.remember(run.retryKey);
  }
}

/**
 * 创建一条 x402 收费路由中间件（卖方侧）。
 *
 * 幂等是收费服务的硬要求：同一张支付凭证 + 同一路径 + 同一请求体，
 * 在服务端失败后重试**不重复计费**（详见 {@link PaidRetryStore}）。
 *
 * @param options - 路由规格、重试记忆、工厂与错误上报钩子
 */
export function createPaidRoute(options: PaidRouteOptions): MiddlewareHandler {
  const retryStore = options.retryStore ?? new PaidRetryStore();
  const build = options.factory ?? createSellerMiddleware;
  const x402 = build({
    config: options.config,
    path: options.path,
    resource: `${options.config.publicBaseUrl}${options.path}`,
    description: options.description,
  });
  const onError = options.onError ?? ((): void => undefined);

  return async (context, next) => {
    const path = new URL(context.req.url).pathname;
    const retryKey = await readRetryKey(context.req.raw, path);
    if (retryKey !== undefined && retryStore.has(retryKey)) {
      // 这一笔已经付过款且我们没交付成功，直接放行，不再进 x402 验款。
      await next();
      return undefined;
    }
    return runPaidRequest({
      context,
      next,
      x402,
      retryStore,
      retryKey,
      path,
      onError,
    });
  };
}
