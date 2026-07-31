import type { SettlePort, VerifyPort } from "@citely/engine/orchestrator";
import { describe, expect, it, vi } from "vitest";

import { createVerifierApp } from "./verifier-app.js";
import type { CreateVerifierAppOptions } from "./verifier-app.js";

const SILENT_LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const TOKEN = "internal-token-value";

const REPORT = { passed: true, reasonHash: `0x${"d".repeat(64)}` as const, outcomes: [] };
const ACTION = { action: "complete", txHash: `0x${"e".repeat(64)}` } as const;

const BODY = {
  sa: {
    case_id: "case-001",
    bound_to: { job_id: "159786", expires_at: "2026-12-31T00:00:00.000Z" },
    attestation: { sa_hash: `0x${"b".repeat(64)}` },
  },
  rubric: { id: "demo" },
  submittedDeliverableHash: `0x${"b".repeat(64)}`,
  chainId: 5_042_002,
};

function buildApp(overrides: Partial<CreateVerifierAppOptions> = {}) {
  const verify: VerifyPort = () => Promise.resolve(REPORT);
  const settle: SettlePort = () => Promise.resolve(ACTION);
  return createVerifierApp({
    verify,
    settle,
    token: TOKEN,
    logger: SILENT_LOGGER,
    ...overrides,
  });
}

// 不用默认参数：显式传 undefined 会落回默认值，"没带令牌"那条用例就永远测不到。
interface PostOptions {
  /** 省略该字段表示**不带** Authorization 头。 */
  readonly token?: string;
}

function post(app: ReturnType<typeof buildApp>, body: unknown, options?: PostOptions) {
  const token = options === undefined ? TOKEN : options.token;
  return app.request("/verify-and-settle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "9.9.9.9",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("createVerifierApp", () => {
  it("空令牌拒绝启动（空令牌等于不设防）", () => {
    expect(() => buildApp({ token: "   " })).toThrow(/INTERNAL_SERVICE_TOKEN/);
  });

  it("体检端点可用", async () => {
    const response = await buildApp().request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", role: "verifier" });
  });

  it("三检与收口在同一次调用里完成", async () => {
    const verify = vi.fn<VerifyPort>(() => Promise.resolve(REPORT));
    const settle = vi.fn<SettlePort>(() => Promise.resolve(ACTION));
    const response = await post(buildApp({ verify, settle }), BODY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verification: REPORT, settlement: ACTION });
    expect(verify).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("收口的 jobId 取自 SA 里签过名的 bound_to，不由请求参数指定", async () => {
    const settle = vi.fn<SettlePort>(() => Promise.resolve(ACTION));
    // 请求里塞一个假的 jobId，必须被忽略。
    await post(buildApp({ settle }), { ...BODY, jobId: "999" });
    expect(settle.mock.calls[0]?.[0].jobId).toBe(159_786n);
  });

  it("收口用的是验证器自己产出的报告，不是请求里带的", async () => {
    const settle = vi.fn<SettlePort>(() => Promise.resolve(ACTION));
    await post(buildApp({ settle }), {
      ...BODY,
      verification: { passed: true, reasonHash: `0x${"f".repeat(64)}`, outcomes: [] },
    });
    expect(settle.mock.calls[0]?.[0].report).toEqual(REPORT);
  });

  it("三检不通过时如实返回，不改写结论", async () => {
    const failed = { passed: false, reasonHash: `0x${"a".repeat(64)}` as const, outcomes: [] };
    const rejected = { action: "reject", txHash: `0x${"9".repeat(64)}` } as const;
    const response = await post(
      buildApp({ verify: () => Promise.resolve(failed), settle: () => Promise.resolve(rejected) }),
      BODY,
    );
    expect(await response.json()).toEqual({ verification: failed, settlement: rejected });
  });

  describe("鉴权", () => {
    it("缺令牌返回 401 且不跑三检", async () => {
      const verify = vi.fn<VerifyPort>(() => Promise.resolve(REPORT));
      const response = await post(buildApp({ verify }), BODY, {});
      expect(response.status).toBe(401);
      expect(verify).not.toHaveBeenCalled();
    });

    it("错令牌返回 401", async () => {
      expect((await post(buildApp(), BODY, { token: "wrong-token" })).status).toBe(401);
    });

    it("长度不同的错令牌同样返回 401（不因长度差异抛错）", async () => {
      expect((await post(buildApp(), BODY, { token: "x" })).status).toBe(401);
      expect((await post(buildApp(), BODY, { token: "x".repeat(500) })).status).toBe(401);
    });

    it("体检端点不需要令牌", async () => {
      expect((await buildApp().request("/health")).status).toBe(200);
    });
  });

  describe("请求体校验", () => {
    it("非 JSON 返回 400", async () => {
      expect((await post(buildApp(), "not json")).status).toBe(400);
    });

    it.each([
      ["sa 缺失", { ...BODY, sa: undefined }],
      ["bound_to 缺失", { ...BODY, sa: { attestation: BODY.sa.attestation } }],
      [
        "job_id 非十进制",
        { ...BODY, sa: { ...BODY.sa, bound_to: { job_id: "0xdeadbeef" } } },
      ],
      [
        "attestation 缺失",
        { ...BODY, sa: { case_id: "c", bound_to: BODY.sa.bound_to } },
      ],
      ["rubric 缺失", { ...BODY, rubric: undefined }],
      ["交付物哈希形状非法", { ...BODY, submittedDeliverableHash: "0x123" }],
      ["chainId 非正整数", { ...BODY, chainId: -1 }],
      ["chainId 是字符串", { ...BODY, chainId: "5042002" }],
    ])("%s 返回 400", async (_label, body) => {
      const verify = vi.fn<VerifyPort>(() => Promise.resolve(REPORT));
      const response = await post(buildApp({ verify }), body);
      expect(response.status).toBe(400);
      expect(verify).not.toHaveBeenCalled();
    });
  });

  it("三检抛错时返回 500 且不泄内部细节", async () => {
    const response = await post(
      buildApp({
        verify: () => Promise.reject(new Error("VERIFIER_PRIVATE_KEY=0xdead 签名失败")),
      }),
      BODY,
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("0xdead");
    expect(text).toContain("internal_error");
  });
});
