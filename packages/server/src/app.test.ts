import { usdc6 } from "@citely/engine";
import type { CaseRunSnapshot } from "@citely/engine/orchestrator";
import type { SettlementAuthorization } from "@citely/engine/sa";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { CreateAppOptions } from "./app.js";
import type { CaseReader, CaseRecord, CaseRunner, RunCaseRequest, RunCaseResult } from "./ports.js";

const SILENT_LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const SA: SettlementAuthorization = {
  case_id: "case-001",
  sa_version: "2.3",
  bound_to: { job_id: "159786", expires_at: "2026-12-31T00:00:00.000Z" },
  modules_used: [{ module_id: "us-msb", version: "2026.07.1", evidence_hash: `0x${"a".repeat(64)}` }],
  legs: [
    {
      party: "uk_service_agent",
      payee: "0x000000000000000000000000000000000000bEEF",
      amount_nominal: "12500000",
      condition: "PASS",
      basis: [{ item_id: "MT-03", verdict: "confirmed_exempt", source: "31 CFR § 1010.100(ff)" }],
      confidence: "high",
    },
  ],
  preview: { condition_summary: "1 PASS", items_covered: 3 },
  attestation: {
    sa_hash: `0x${"b".repeat(64)}`,
    signer: "0x000000000000000000000000000000000000A11c",
    signed_at: "2026-07-30T00:00:00.000Z",
    signature: `0x${"c".repeat(130)}`,
  },
};

const RESULT: RunCaseResult = {
  caseId: "case-001",
  jobId: 159_786n,
  routing: {
    exit: "high_confidence",
    chainAction: "submit",
    actor: "operator",
    reason: "全部判定项高置信",
  },
  sa: SA,
  saHash: SA.attestation.sa_hash,
  adjudication: [],
  verification: {
    passed: true,
    reasonHash: `0x${"d".repeat(64)}`,
    outcomes: [{ check: "deliverable_signature", passed: true, failures: [] }],
  },
  settlement: { action: "complete", txHash: `0x${"e".repeat(64)}` },
  procurement: { settlementId: "settle-1", paidAtomic: "800000", reused: false },
  briefingPack: null,
  ledger: [
    {
      account: "operator",
      direction: "in",
      category: "case_fee",
      amount_nominal: usdc6(3_000_000n),
      amount_actual: usdc6(3_000_000n),
      ref: "159786",
      ref_type: "jobId",
      caseId: "case-001",
      settlement_tx: null,
    },
  ],
  replayed: false,
};

const SNAPSHOT: CaseRunSnapshot = {
  caseId: "case-001",
  jobId: "159786",
  routing: RESULT.routing,
  sa: SA,
  saHash: SA.attestation.sa_hash,
  adjudication: [],
  verification: RESULT.verification,
  settlement: RESULT.settlement,
  procurement: RESULT.procurement,
  briefingPack: null,
};

const RECORD: CaseRecord = {
  caseId: "case-001",
  state: "settled",
  exitReason: "completed",
  jobId: "159786",
  snapshot: SNAPSHOT,
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const DEAL = {
  deal_id: "case-001",
  parties: [
    { role: "payer", country: "US" },
    { role: "payee", country: "GB" },
  ],
  activity: "money_transmission",
  amount_usdc: 12_500,
  evidence: {},
  // 收款方与到期时刻是 DealInput 之外的必填项：没有 payee 产不出 SA，
  // 到期时刻由调用方给定才能保证 sa_hash 可复现（见 case-request.ts）。
  settlement: {
    party: "uk_service_agent",
    payee: "0x000000000000000000000000000000000000bEEF",
    amount_usdc: "12500.00",
  },
  expires_at: "2026-12-31T00:00:00.000Z",
};

function stubRunner(result: RunCaseResult = RESULT): CaseRunner & { calls: RunCaseRequest[] } {
  const calls: RunCaseRequest[] = [];
  return {
    calls,
    runCase: (request) => {
      calls.push(request);
      return Promise.resolve(result);
    },
  };
}

// 不用默认参数：显式传 undefined 会落回默认值，"查不到案件"那条用例就永远测不到。
function stubReader(record?: CaseRecord): CaseReader {
  return { readCase: () => Promise.resolve(record) };
}

function stubReaderFound(): CaseReader {
  return stubReader(RECORD);
}

function buildApp(overrides: Partial<CreateAppOptions> = {}) {
  return createApp({
    caseRunner: stubRunner(),
    caseReader: stubReaderFound(),
    card: { baseUrl: "https://deal-desk.test", priceUsdc: "3.000000", payTo: "0xA1" },
    logger: SILENT_LOGGER,
    ...overrides,
  });
}

function postCase(app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/cases", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...headers },
    body: JSON.stringify(body),
  });
}

describe("GET /health", () => {
  it("返回 ok", async () => {
    const response = await buildApp().request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("/healthz 是同义别名", async () => {
    expect((await buildApp().request("/healthz")).status).toBe(200);
  });

  it("不受限流影响", async () => {
    const app = buildApp({ rateLimit: { windowMs: 60_000, maxRequests: 1, trustProxyHeader: true } });
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request("/health")).status).toBe(200);
    }
  });
});

describe("GET /", () => {
  it("列出端点与能力并带免责声明", async () => {
    const body = (await (await buildApp().request("/")).json()) as Record<string, unknown>;
    expect(body["disclaimer"]).toContain("Not legal advice");
    expect(body["endpoints"]).toMatchObject({ create_case: "POST /cases (x402 paid)" });
    expect(Array.isArray(body["capabilities"])).toBe(true);
  });
});

describe("agent card", () => {
  it("well-known 路径可取到 card", async () => {
    const response = await buildApp().request("/.well-known/agent-card.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    const card = (await response.json()) as Record<string, unknown>;
    expect(card["name"]).toBe("Citely Deal Desk");
    expect(card["x402Support"]).toBe(true);
  });

  // card 里写了 image 不等于那张图取得到。这条测试**从 card 声明的 URL 反推路由**，
  // 而不是直接 request 一个硬编码路径——否则改了 AGENT_IMAGE_PATH 而忘了改 card，
  // 两边各自绿，线上却是一个 404 的图。
  it("card 声明的 image URL 真的能取到 PNG", async () => {
    const app = buildApp();
    const card = (await (await app.request("/.well-known/agent-card.json")).json()) as Record<
      string,
      unknown
    >;
    const image = card["image"];
    expect(typeof image).toBe("string");
    expect(image).toBe("https://deal-desk.test/static/agent-icon.png");

    const path = new URL(image as string).pathname;
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age=86400");

    // 真的是 PNG 字节，不是一个 200 的空响应或错误页。
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("未注册 8004 时 registration 返回 404，不作空声明", async () => {
    const response = await buildApp().request("/.well-known/agent-registration.json");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "agent_not_registered" });
  });

  it("已注册时给出 registration", async () => {
    const app = buildApp({
      card: {
        baseUrl: "https://deal-desk.test",
        priceUsdc: "3.000000",
        payTo: "0xA1",
        agentId: 42,
        identityRegistry: "0x00000000000000000000000000000000000000B2",
      },
    });
    const response = await app.request("/.well-known/agent-registration.json");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ registrations: [{ agentId: 42 }] });
  });
});

describe("POST /cases", () => {
  it("跑完全链路并返回签名 SA", async () => {
    const runner = stubRunner();
    const response = await postCase(buildApp({ caseRunner: runner }), DEAL);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["case_id"]).toBe("case-001");
    expect(body["sa"]).toMatchObject({ attestation: { sa_hash: SA.attestation.sa_hash } });
    expect(body["verification"]).toMatchObject({ passed: true });
    expect(body["settlement"]).toMatchObject({ action: "complete" });
    expect(body["disclaimer"]).toContain("Not legal advice");
    expect(runner.calls[0]?.deal.deal_id).toBe("case-001");
    expect(runner.calls[0]?.settlement.payee).toBe("0x000000000000000000000000000000000000bEEF");
    expect(runner.calls[0]?.expiresAt.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("把 bigint 金额与 jobId 投影成字符串（JSON 不认 bigint）", async () => {
    const body = (await (await postCase(buildApp(), DEAL)).json()) as Record<string, unknown>;
    expect(body["job_id"]).toBe("159786");
    const ledger = body["ledger"] as Record<string, unknown>[];
    expect(ledger[0]).toMatchObject({
      amount_nominal: "3000000",
      amount_actual: "3000000",
      settlement_tx: null,
    });
  });

  it("命中幂等重放时回 200 而不是 201", async () => {
    const app = buildApp({ caseRunner: stubRunner({ ...RESULT, replayed: true }) });
    const response = await postCase(app, DEAL);
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ replayed: true });
  });

  it("请求体非法时 400，且**不进收费闸**", async () => {
    const gate = vi.fn<MiddlewareHandler>(async (_context, next) => {
      await next();
    });
    const response = await postCase(buildApp({ paymentGate: gate }), { deal_id: "" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(gate).not.toHaveBeenCalled();
  });

  it("非 JSON 请求体返回 400", async () => {
    const app = buildApp();
    const response = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("合法请求会经过收费闸", async () => {
    const gate = vi.fn<MiddlewareHandler>(async (_context, next) => {
      await next();
    });
    expect((await postCase(buildApp({ paymentGate: gate }), DEAL)).status).toBe(201);
    expect(gate).toHaveBeenCalledOnce();
  });

  it("收费闸拒付时不跑案件", async () => {
    const runner = stubRunner();
    const gate: MiddlewareHandler = (context) =>
      Promise.resolve(context.json({ error: "payment_required" }, 402));
    const response = await postCase(buildApp({ caseRunner: runner, paymentGate: gate }), DEAL);
    expect(response.status).toBe(402);
    expect(runner.calls).toHaveLength(0);
  });

  it("把付款凭证标识透传给编排器", async () => {
    const runner = stubRunner();
    const app = buildApp({
      caseRunner: runner,
      readPayment: () => ({ credentialId: "cred-1", settlementId: "settle-1" }),
    });
    await postCase(app, DEAL);
    expect(runner.calls[0]?.payment).toEqual({ credentialId: "cred-1", settlementId: "settle-1" });
  });

  it("超过体积上限返回 413", async () => {
    const app = buildApp();
    const huge = { ...DEAL, evidence: { blob: "x".repeat(300 * 1024) } };
    const response = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify(huge),
    });
    expect(response.status).toBe(413);
  });

  it("编排失败返回 500 且不泄内部细节", async () => {
    const failing: CaseRunner = {
      runCase: () => Promise.reject(new Error("OPERATOR_PRIVATE_KEY=0xdeadbeef 连接失败")),
    };
    const response = await postCase(buildApp({ caseRunner: failing }), DEAL);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("0xdeadbeef");
    expect(text).toContain("internal_error");
  });
});

describe("GET /cases/:id", () => {
  it("返回案件状态与 SA", async () => {
    const response = await buildApp().request("/cases/case-001", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["state"]).toBe("settled");
    expect(body["snapshot"]).toMatchObject({ sa: { case_id: "case-001" } });
  });

  it("不存在的案件返回 404", async () => {
    const app = buildApp({ caseReader: stubReader() });
    const response = await app.request("/cases/case-999", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "case_not_found" });
  });

  it("形状非法的 case id 返回 400，不落到存储查询", async () => {
    const reader = { readCase: vi.fn() };
    const app = buildApp({ caseReader: reader as unknown as CaseReader });
    const response = await app.request("/cases/..%2Fetc%2Fpasswd", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(response.status).toBe(400);
    expect(reader.readCase).not.toHaveBeenCalled();
  });
});

describe("限流", () => {
  it("超额返回 429", async () => {
    const app = buildApp({ rateLimit: { windowMs: 60_000, maxRequests: 1, trustProxyHeader: true } });
    const headers = { "x-forwarded-for": "7.7.7.7" };
    expect((await app.request("/cases/case-001", { headers })).status).toBe(200);
    expect((await app.request("/cases/case-001", { headers })).status).toBe(429);
  });
});
