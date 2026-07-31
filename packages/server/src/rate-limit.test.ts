import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limit.js";

interface Clock {
  advance: (ms: number) => void;
  now: () => number;
}

function fakeClock(start = 1_000): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function appWith(limiter: ReturnType<typeof createRateLimiter>): Hono {
  const app = new Hono();
  app.use("*", limiter);
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.get("/cases/:id", (context) => context.json({ id: context.req.param("id") }));
  return app;
}

const PROXY_HEADERS = { headers: { "x-forwarded-for": "9.9.9.9" } };

describe("createRateLimiter", () => {
  it("窗口内超额返回 429", async () => {
    const app = appWith(
      createRateLimiter({ windowMs: 1000, maxRequests: 2, trustProxyHeader: true }),
    );
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(200);
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(200);
    const blocked = await app.request("/cases/a", PROXY_HEADERS);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: "rate_limit_exceeded" });
  });

  it("窗口过期后额度恢复", async () => {
    const clock = fakeClock();
    const app = appWith(
      createRateLimiter({
        windowMs: 1000,
        maxRequests: 1,
        trustProxyHeader: true,
        now: clock.now,
      }),
    );
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(200);
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(429);
    clock.advance(1001);
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(200);
  });

  it("不同 case id 归并到同一个桶（避免逐 id 绕过限流）", async () => {
    const app = appWith(
      createRateLimiter({ windowMs: 1000, maxRequests: 1, trustProxyHeader: true }),
    );
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(200);
    expect((await app.request("/cases/b", PROXY_HEADERS)).status).toBe(429);
  });

  it("shouldSkip 命中的请求不计数", async () => {
    const app = appWith(
      createRateLimiter({
        windowMs: 1000,
        maxRequests: 1,
        trustProxyHeader: true,
        shouldSkip: (context) => context.req.path === "/health",
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request("/health", PROXY_HEADERS)).status).toBe(200);
    }
  });

  it("不同来源 IP 互不影响", async () => {
    const app = appWith(
      createRateLimiter({ windowMs: 1000, maxRequests: 1, trustProxyHeader: true }),
    );
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(200);
    const other = await app.request("/cases/a", { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(other.status).toBe(200);
  });

  it("不信任代理头时忽略 x-forwarded-for", async () => {
    const app = appWith(
      createRateLimiter({ windowMs: 1000, maxRequests: 1, trustProxyHeader: false }),
    );
    expect((await app.request("/cases/a", PROXY_HEADERS)).status).toBe(200);
    // 伪造的 IP 被忽略，两次请求落进同一个 "unknown" 桶。
    const second = await app.request("/cases/a", { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(second.status).toBe(429);
  });

  it("resolveBucket 可为已付费请求放宽额度", async () => {
    const app = appWith(
      createRateLimiter({
        windowMs: 1000,
        maxRequests: 1,
        trustProxyHeader: true,
        resolveBucket: (context) =>
          context.req.header("x-paid") === "yes"
            ? { key: "paid", maxRequests: 3 }
            : undefined,
      }),
    );
    const paid = { headers: { "x-forwarded-for": "9.9.9.9", "x-paid": "yes" } };
    expect((await app.request("/cases/a", paid)).status).toBe(200);
    expect((await app.request("/cases/a", paid)).status).toBe(200);
    expect((await app.request("/cases/a", paid)).status).toBe(200);
    expect((await app.request("/cases/a", paid)).status).toBe(429);
  });

  it("桶数量到上限后淘汰最老的桶", async () => {
    const app = appWith(
      createRateLimiter({
        windowMs: 60_000,
        maxRequests: 1,
        trustProxyHeader: true,
        maxBuckets: 2,
      }),
    );
    await app.request("/cases/a", { headers: { "x-forwarded-for": "1.1.1.1" } });
    await app.request("/cases/a", { headers: { "x-forwarded-for": "2.2.2.2" } });
    await app.request("/cases/a", { headers: { "x-forwarded-for": "3.3.3.3" } });
    // 1.1.1.1 的桶已被淘汰，它的额度重新可用（内存有界优先于绝对精确）。
    const revived = await app.request("/cases/a", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(revived.status).toBe(200);
  });

  it("非法窗口或额度直接抛错", () => {
    expect(() =>
      createRateLimiter({ windowMs: 0, maxRequests: 1, trustProxyHeader: false }),
    ).toThrow(/限流窗口/);
    expect(() =>
      createRateLimiter({ windowMs: 1000, maxRequests: -1, trustProxyHeader: false }),
    ).toThrow(/请求上限/);
  });
});
