/**
 * 演示链路的 HTTP 面：外部 Job 放行付费门、409 映射、/app 静态页与 demo 端点。
 *
 * 最重要的断言不是新功能能用，而是**旧行为一字不变**：
 * 不带 `job_id` 的请求必须照样撞上 x402 门。
 */

import { ExternalJobError } from "@citely/engine/orchestrator";
import { usdc6FromDecimal } from "@citely/engine";
import type { IdempotencyRecord, IdempotencyStore, JobClient, JobView } from "@citely/chain/types";
import { agenticCommerceAbi, idempotencyKey } from "@citely/chain";
import { decodeFunctionData, erc20Abi, zeroAddress } from "viem";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import { createDemoApi, DemoApiError } from "./demo-api.js";
import { parseCaseRequest } from "./case-request.js";
import type { CaseReader, CaseRunner } from "./ports.js";

const SILENT_LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const PROVIDER = "0x1111111111111111111111111111111111111111" as const;
const EVALUATOR = "0x2222222222222222222222222222222222222222" as const;
const JOB_CONTRACT = "0x4444444444444444444444444444444444444444" as const;
const USDC = "0x5555555555555555555555555555555555555555" as const;
const CLIENT = "0x3333333333333333333333333333333333333333" as const;

const DEAL = {
  deal_id: "case-001",
  parties: [
    { role: "payer", country: "US" },
    { role: "payee", country: "GB" },
  ],
  activity: "money_transmission",
  amount_usdc: 12_500,
  evidence: {},
  settlement: {
    party: "uk_service_agent",
    payee: "0x000000000000000000000000000000000000bEEF",
    amount_usdc: "12500.00",
  },
  expires_at: "2026-12-31T00:00:00.000Z",
};

/** 一律 402 的假门：分辨"进了门"还是"绕过了门"。 */
const ALWAYS_402: MiddlewareHandler = (context) => Promise.resolve(context.json({ error: "payment_required" }, 402));

function stubRunner(impl?: () => Promise<never>): CaseRunner {
  return {
    runCase: impl ?? (() => Promise.reject(new Error("runner should not be reached"))),
  } as unknown as CaseRunner;
}

const EMPTY_READER: CaseReader = { readCase: () => Promise.resolve(undefined) };

type FakeJobClient = JobClient & { setBudgetCalls: bigint[]; getJobCalls: bigint[] };

function fakeJobClient(job?: Partial<JobView>, getJobError?: Error): FakeJobClient {
  const view: JobView = {
    id: 42n,
    client: CLIENT,
    provider: PROVIDER,
    evaluator: EVALUATOR,
    description: "d",
    budget: 0n,
    expiredAt: 9_999_999_999n,
    status: "open",
    hook: zeroAddress,
    ...job,
  };
  const setBudgetCalls: bigint[] = [];
  const getJobCalls: bigint[] = [];
  return {
    setBudgetCalls,
    getJobCalls,
    getJob: (jobId: bigint) => {
      getJobCalls.push(jobId);
      return getJobError === undefined ? Promise.resolve(view) : Promise.reject(getJobError);
    },
    setBudget: (jobId: bigint) => {
      setBudgetCalls.push(jobId);
      return Promise.resolve(`0x${"ab".repeat(32)}`);
    },
  } as unknown as FakeJobClient;
}

/** tx_log 替身：只允许 lookup，写入即失败（demo 只读端点绝不该写）。 */
function fakeTxLog(entries: Readonly<Record<string, `0x${string}`>> = {}): IdempotencyStore & {
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    lookup: (key: string): Promise<IdempotencyRecord | null> => {
      lookups.push(key);
      const txHash = entries[key];
      return Promise.resolve(
        txHash === undefined ? null : { key, txHash, submittedAt: "2026-08-02T00:00:00.000Z" },
      );
    },
    record: () => Promise.reject(new Error("demo api must never write to tx_log")),
  };
}

interface DemoParts {
  readonly api: ReturnType<typeof createDemoApi>;
  readonly jobClient: FakeJobClient;
  readonly txLog: IdempotencyStore & { lookups: string[] };
  readonly clock: { ms: number };
}

function demoParts(options?: {
  readonly job?: Partial<JobView>;
  readonly getJobError?: Error;
  readonly txEntries?: Readonly<Record<string, `0x${string}`>>;
}): DemoParts {
  const jobClient = fakeJobClient(options?.job, options?.getJobError);
  const txLog = fakeTxLog(options?.txEntries);
  const clock = { ms: 1_700_000_000_000 };
  const api = createDemoApi({
    jobClient,
    txLog,
    config: {
      chainId: 5_042_002,
      jobContract: JOB_CONTRACT,
      usdc: USDC,
      provider: PROVIDER,
      evaluator: EVALUATOR,
      caseBudget: usdc6FromDecimal("3.00"),
    },
    nowMs: () => clock.ms,
  });
  return { api, jobClient, txLog, clock };
}

function demoApi(job?: Partial<JobView>) {
  return demoParts(job === undefined ? {} : { job }).api;
}

function appWith(options: Parameters<typeof createApp>[0]) {
  return createApp(options);
}

function post(app: ReturnType<typeof createApp>, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("parseCaseRequest 的 job_id", () => {
  it("缺省合法，值不进结果对象", () => {
    const parsed = parseCaseRequest(DEAL);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect("jobId" in parsed.value).toBe(false);
  });

  it("十进制字符串 → bigint", () => {
    const parsed = parseCaseRequest({ ...DEAL, job_id: "162523" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.jobId).toBe(162_523n);
  });

  it.each([[123], ["0x7b"], [""], ["12.5"], ["-1"]])("非法形状 %j → invalid_request", (raw) => {
    const parsed = parseCaseRequest({ ...DEAL, job_id: raw });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some((i) => i.path === "job_id")).toBe(true);
  });
});

describe("付费门与外部 Job", () => {
  it("不带 job_id：照样撞上 x402 门（现有行为一字不变）", async () => {
    const app = appWith({
      caseRunner: stubRunner(),
      caseReader: EMPTY_READER,
      paymentGate: ALWAYS_402,
      card: { baseUrl: "https://t.test", priceUsdc: "1.000000", payTo: PROVIDER },
      logger: SILENT_LOGGER,
    });
    const response = await post(app, "/cases", DEAL);
    expect(response.status).toBe(402);
  });

  it("带 job_id：绕过门直达业务（托管即付款）", async () => {
    const runner = {
      calls: [] as unknown[],
      runCase(request: unknown) {
        this.calls.push(request);
        return Promise.reject(new ExternalJobError("wrong_status", "stub"));
      },
    };
    const app = appWith({
      caseRunner: runner as unknown as CaseRunner,
      caseReader: EMPTY_READER,
      paymentGate: ALWAYS_402,
      card: { baseUrl: "https://t.test", priceUsdc: "1.000000", payTo: PROVIDER },
      logger: SILENT_LOGGER,
    });
    const response = await post(app, "/cases", { ...DEAL, job_id: "42" });
    // 没停在 402，真的到了 runner——再由 ExternalJobError 映射 409。
    expect(runner.calls).toHaveLength(1);
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("external_job_rejected");
    expect(body["reason"]).toBe("wrong_status");
  });

  it("job_id 形状非法：门前校验直接 400，不进门也不进业务", async () => {
    const app = appWith({
      caseRunner: stubRunner(),
      caseReader: EMPTY_READER,
      paymentGate: ALWAYS_402,
      card: { baseUrl: "https://t.test", priceUsdc: "1.000000", payTo: PROVIDER },
      logger: SILENT_LOGGER,
    });
    const response = await post(app, "/cases", { ...DEAL, job_id: "0x7b" });
    expect(response.status).toBe(400);
  });
});

describe("/app 静态页与 demo 端点", () => {
  function demoApp(job?: Partial<JobView>) {
    return appWith({
      caseRunner: stubRunner(),
      caseReader: EMPTY_READER,
      card: { baseUrl: "https://t.test", priceUsdc: null, payTo: null },
      logger: SILENT_LOGGER,
      demo: demoApi(job),
    });
  }

  it("不给 demo 选项就没有 /app（最小部署不多长口子）", async () => {
    const app = appWith({
      caseRunner: stubRunner(),
      caseReader: EMPTY_READER,
      card: { baseUrl: "https://t.test", priceUsdc: null, payTo: null },
      logger: SILENT_LOGGER,
    });
    expect((await app.request("/app")).status).toBe(404);
    expect((await app.request("/app/api/config")).status).toBe(404);
    expect((await app.request("/app/api/jobs/42")).status).toBe(404);
  });

  it.each([
    ["/app", "text/html; charset=utf-8"],
    ["/app/app.js", "text/javascript; charset=utf-8"],
    ["/app/style.css", "text/css; charset=utf-8"],
  ])("%s → 200 且 content-type 正确", async (path, contentType) => {
    const response = await demoApp().request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect((await response.text()).length).toBeGreaterThan(100);
  });

  it("config 端点全是公开信息，不含任何密钥形状的字符串", async () => {
    const response = await demoApp().request("/app/api/config");
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    // event topic 本身就是 32 字节 hex，长得和私钥一模一样——它是公开信息，
    // 剔除后剩余内容不得再有任何 64 位 hex。
    const topic = body["job_created_topic"] as string;
    expect(topic).toMatch(/^0x[0-9a-f]{64}$/);
    expect(text.replaceAll(topic, "")).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(text).not.toContain("PRIVATE_KEY");
    expect(body["job_contract"]).toBe(JOB_CONTRACT);
    expect(body["case_budget_atomic"]).toBe("3000000");
  });

  it("encode createJob：provider/evaluator 由服务端填死，调用方伪造不了角色", async () => {
    const response = await post(demoApp(), "/app/api/encode", {
      action: "createJob",
      params: { expired_at: "1900000000" },
    });
    expect(response.status).toBe(200);
    const tx = (await response.json()) as { to: string; data: `0x${string}` };
    expect(tx.to).toBe(JOB_CONTRACT);
    const decoded = decodeFunctionData({ abi: agenticCommerceAbi, data: tx.data });
    expect(decoded.functionName).toBe("createJob");
    expect(decoded.args?.[0]).toBe(PROVIDER);
    expect(decoded.args?.[1]).toBe(EVALUATOR);
    expect(decoded.args?.[2]).toBe(1_900_000_000n);
  });

  it("encode approve：花费对象是 Job 合约、金额恒为 caseBudget", async () => {
    const response = await post(demoApp(), "/app/api/encode", { action: "approve", params: {} });
    const tx = (await response.json()) as { to: string; data: `0x${string}` };
    expect(tx.to).toBe(USDC);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args?.[0]).toBe(JOB_CONTRACT);
    expect(decoded.args?.[1]).toBe(3_000_000n);
  });

  it("encode fund：jobId 透传", async () => {
    const response = await post(demoApp(), "/app/api/encode", {
      action: "fund",
      params: { job_id: "42" },
    });
    const tx = (await response.json()) as { to: string; data: `0x${string}` };
    const decoded = decodeFunctionData({ abi: agenticCommerceAbi, data: tx.data });
    expect(decoded.functionName).toBe("fund");
    expect(decoded.args?.[0]).toBe(42n);
  });

  it("encode 未知 action → 400", async () => {
    const response = await post(demoApp(), "/app/api/encode", { action: "steal", params: {} });
    expect(response.status).toBe(400);
  });

  it("set-budget：open 且 provider 是我们 → 200 并调用 jobClient", async () => {
    const response = await post(demoApp(), "/app/api/jobs/42/set-budget");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["tx_hash"]).toMatch(/^0x/);
  });

  it("set-budget：Job 不存在（client 归零）→ 404", async () => {
    const response = await post(demoApp({ client: zeroAddress }), "/app/api/jobs/42/set-budget");
    expect(response.status).toBe(404);
  });

  it("set-budget：provider 不是我们 → 409", async () => {
    const response = await post(demoApp({ provider: CLIENT }), "/app/api/jobs/42/set-budget");
    expect(response.status).toBe(409);
  });

  it("set-budget：已 funded → 409（不是 open 不该再动预算）", async () => {
    const response = await post(demoApp({ status: "funded" }), "/app/api/jobs/42/set-budget");
    expect(response.status).toBe(409);
  });

  it("set-budget：id 形状非法 → 400", async () => {
    const response = await post(demoApp(), "/app/api/jobs/not-a-number/set-budget");
    expect(response.status).toBe(400);
  });
});

describe("GET /app/api/jobs/:id —— 链上 Job 只读视图", () => {
  const JOB_STATES = ["open", "funded", "submitted", "completed", "rejected", "expired"];

  function appFor(parts: DemoParts) {
    return appWith({
      caseRunner: stubRunner(),
      caseReader: EMPTY_READER,
      card: { baseUrl: "https://t.test", priceUsdc: null, payTo: null },
      logger: SILENT_LOGGER,
      demo: parts.api,
    });
  }

  it("合法 jobId → 200，字段齐全且 status 是六态之一", async () => {
    const parts = demoParts({ job: { status: "completed", budget: 3_000_000n } });
    const response = await appFor(parts).request("/app/api/jobs/42");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["job_id"]).toBe("42");
    expect(JOB_STATES).toContain(body["status"]);
    expect(body["client"]).toBe(CLIENT);
    expect(body["provider"]).toBe(PROVIDER);
    expect(body["evaluator"]).toBe(EVALUATOR);
    expect(body["budget_atomic"]).toBe("3000000");
    expect(body["expired_at"]).toBe("9999999999");
    expect(body["tx"]).toEqual({});
  });

  it("Job 不存在（client 归零）→ 404 job_not_found", async () => {
    const parts = demoParts({ job: { client: zeroAddress } });
    const response = await appFor(parts).request("/app/api/jobs/42");
    expect(response.status).toBe(404);
    expect(((await response.json()) as Record<string, unknown>)["error"]).toBe("job_not_found");
  });

  it.each([["not-a-number"], ["1e5"], ["0x2a"], ["1".repeat(79)]])(
    "id 形状非法 %j → 400 且链读一次都没发生",
    async (raw) => {
      const parts = demoParts();
      const response = await appFor(parts).request(`/app/api/jobs/${raw}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as Record<string, unknown>)["error"]).toBe("invalid_job_id");
      expect(parts.jobClient.getJobCalls).toHaveLength(0);
    },
  );

  it("链读抛错 → 502，且响应体不含 RPC 原始错误（可能带 URL/key）", async () => {
    const sentinel = "https://secret-rpc.example/KEY123";
    const parts = demoParts({ getJobError: new Error(`fetch failed: ${sentinel}`) });
    const response = await appFor(parts).request("/app/api/jobs/42");
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("KEY123");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body["error"]).toBe("chain_unavailable");
    expect(body["message"]).toBe("Chain read failed; try again.");
  });

  it("tx 来自 tx_log，键由 idempotencyKey(jobId, action) 构造", async () => {
    const submitTx = `0x${"11".repeat(32)}` as const;
    const completeTx = `0x${"22".repeat(32)}` as const;
    const setBudgetTx = `0x${"33".repeat(32)}` as const;
    const parts = demoParts({
      job: { status: "completed" },
      txEntries: {
        [idempotencyKey(42n, "setBudget")]: setBudgetTx,
        [idempotencyKey(42n, "submit")]: submitTx,
        [idempotencyKey(42n, "complete")]: completeTx,
      },
    });
    const response = await appFor(parts).request("/app/api/jobs/42");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tx: Record<string, string> };
    // reject 从未发生 → 该键根本不存在（不是 null 占位）。
    expect(body.tx).toEqual({ set_budget: setBudgetTx, submit: submitTx, complete: completeTx });
    expect(parts.txLog.lookups).toEqual([
      "42:setBudget",
      "42:submit",
      "42:complete",
      "42:reject",
    ]);
  });

  it("TTL 内重复请求只触发一次链读，超时后才再读一次", async () => {
    const parts = demoParts();
    const app = appFor(parts);
    await app.request("/app/api/jobs/42");
    await app.request("/app/api/jobs/42");
    await app.request("/app/api/jobs/42");
    expect(parts.jobClient.getJobCalls).toHaveLength(1);
    parts.clock.ms += 10_001;
    await app.request("/app/api/jobs/42");
    expect(parts.jobClient.getJobCalls).toHaveLength(2);
  });

  it("不同 jobId 各自缓存，互不串味", async () => {
    const parts = demoParts();
    const app = appFor(parts);
    await app.request("/app/api/jobs/42");
    await app.request("/app/api/jobs/43");
    expect(parts.jobClient.getJobCalls).toEqual([42n, 43n]);
  });
});

describe("DemoApiError", () => {
  it("带状态码，路由层原样映射", () => {
    const error = new DemoApiError(409, "x");
    expect(error.status).toBe(409);
    expect(error.name).toBe("DemoApiError");
  });
});
