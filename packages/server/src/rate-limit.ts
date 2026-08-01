/**
 * 固定窗口限流中间件（单实例部署适用）。
 *
 * 结构照搬上游 msb-agent 的 `src/http/rate-limit.ts`，只改路由前缀归并规则——
 * 两个服务的限流语义保持一致，出问题时排查经验可以互用。
 *
 * 桶数量设上限并做淘汰：否则伪造源 IP 就能把内存撑爆，限流器本身成了 DoS 面。
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

import { DISCLAIMER } from "./constants.js";

export interface RateLimitBucketOverride {
  readonly key: string;
  readonly maxRequests: number;
}

export interface RateLimiterOptions {
  /** 时间窗口长度（毫秒）。 */
  readonly windowMs: number;
  /** 单窗口内允许的请求数。 */
  readonly maxRequests: number;
  /** 是否信任反向代理头（Railway 等 PaaS 后面必须开，否则所有请求同一个 IP）。 */
  readonly trustProxyHeader: boolean;
  /** 桶数量上限，超出后淘汰过期桶/最老桶。 */
  readonly maxBuckets?: number;
  readonly now?: () => number;
  /** 返回 true 则跳过限流（如体检端点）。 */
  readonly shouldSkip?: (context: Context) => boolean | Promise<boolean>;
  /** 自定义分桶（如已付费请求给更宽的额度）。 */
  readonly resolveBucket?: (
    context: Context,
  ) => RateLimitBucketOverride | undefined | Promise<RateLimitBucketOverride | undefined>;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_BUCKETS = 10_000;

function getClientIp(context: Context, isTrustedProxy: boolean): string {
  if (isTrustedProxy) {
    const forwardedFor = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwardedFor !== undefined && forwardedFor !== "") return forwardedFor;
    const realIp = context.req.header("x-real-ip")?.trim();
    if (realIp !== undefined && realIp !== "") return realIp;
  }
  try {
    return getConnInfo(context).remote.address ?? "unknown";
  } catch {
    // Hono 的 app.request() 测试环境没有 Node 连接对象；真实服务始终由连接层提供。
    return "unknown";
  }
}

/** 把带路径参数的路由归并成同一个前缀，避免每个 case id 各占一个桶。 */
function getRoutePrefix(path: string): string {
  if (path.startsWith("/.well-known/")) return "/.well-known";
  if (/^\/cases\/[^/]+$/.test(path)) return "/cases/:id";
  return path;
}

function assertPositiveInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what}必须是大于 0 的整数`);
  }
}

/**
 * 创建固定窗口限流中间件。
 *
 * @param options - 窗口、额度与分桶策略
 * @returns hono 中间件
 * @throws {Error} 窗口或额度不是正整数
 */
export function createRateLimiter(options: RateLimiterOptions): MiddlewareHandler {
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  assertPositiveInt(options.windowMs, "限流窗口");
  assertPositiveInt(options.maxRequests, "请求上限");
  assertPositiveInt(maxBuckets, "桶数量上限");

  const buckets = new Map<string, RateLimitBucket>();
  const now = options.now ?? Date.now;

  function makeRoom(currentTime: number): void {
    if (buckets.size < maxBuckets) return;
    for (const [key, bucket] of buckets) {
      if (currentTime >= bucket.resetAt) buckets.delete(key);
    }
    if (buckets.size < maxBuckets) return;
    // Map 迭代序即插入序，最老的桶排在最前。
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }

  return async (context, next) => {
    if ((await options.shouldSkip?.(context)) === true) {
      await next();
      return undefined;
    }
    const currentTime = now();
    const override = await options.resolveBucket?.(context);
    if (override !== undefined) assertPositiveInt(override.maxRequests, "自定义请求上限");

    const key =
      override?.key ??
      `${getClientIp(context, options.trustProxyHeader)}:${getRoutePrefix(context.req.path)}`;
    const maxRequests = override?.maxRequests ?? options.maxRequests;

    const existing = buckets.get(key);
    const bucket =
      existing === undefined || currentTime >= existing.resetAt
        ? { count: 0, resetAt: currentTime + options.windowMs }
        : existing;
    bucket.count += 1;
    if (existing === undefined) makeRoom(currentTime);
    buckets.set(key, bucket);

    if (bucket.count > maxRequests) {
      return context.json(
        {
          error: "rate_limit_exceeded",
          message: "Too many requests. Please retry later.",
          disclaimer: DISCLAIMER,
        },
        429,
      );
    }
    await next();
    return undefined;
  };
}
