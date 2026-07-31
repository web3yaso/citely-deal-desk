import type { VerifyRequest } from "@citely/engine/orchestrator";
import type { LoadedRubric } from "@citely/engine/rubric";
import type { SettlementAuthorization } from "@citely/engine/sa";
import { describe, expect, it, vi } from "vitest";

import { createRemoteVerifier, RemoteVerifierError } from "./verify-client.js";

const SA = {
  case_id: "case-001",
  sa_version: "2.3",
  bound_to: { job_id: "159786", expires_at: "2026-12-31T00:00:00.000Z" },
  modules_used: [],
  legs: [],
  preview: { condition_summary: "1 PASS", items_covered: 1 },
  attestation: {
    sa_hash: `0x${"b".repeat(64)}`,
    signer: "0x000000000000000000000000000000000000A11c",
    signed_at: "2026-07-30T00:00:00.000Z",
    signature: `0x${"c".repeat(130)}`,
  },
} as unknown as SettlementAuthorization;

const REQUEST: VerifyRequest = {
  sa: SA,
  rubric: {} as LoadedRubric,
  submittedDeliverableHash: SA.attestation.sa_hash,
  chainId: 5_042_002,
};

const OK_BODY = {
  verification: { passed: true, reasonHash: `0x${"d".repeat(64)}`, outcomes: [] },
  settlement: { action: "complete", txHash: `0x${"e".repeat(64)}` },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function verifierWith(fetchImpl: typeof fetch) {
  return createRemoteVerifier({
    baseUrl: "https://verifier.internal/",
    token: "s3cr3t-token-value",
    fetchImpl,
  });
}

describe("createRemoteVerifier", () => {
  it("verify 打到 /verify-and-settle 并带 Bearer 令牌", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(OK_BODY)));
    const report = await verifierWith(fetchImpl).verify(REQUEST);

    expect(report).toMatchObject({ passed: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    // 基地址尾斜杠被规范化掉，不出现双斜杠。
    expect(url).toBe("https://verifier.internal/verify-and-settle");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer s3cr3t-token-value");
  });

  it("settle 取回同一次调用的收口结果，不二次请求", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(OK_BODY)));
    const verifier = verifierWith(fetchImpl);
    const report = await verifier.verify(REQUEST);
    const action = await verifier.settle({ jobId: 159_786n, report });

    expect(action).toEqual({ action: "complete", txHash: `0x${"e".repeat(64)}` });
    // 关键：三检结论与收口都出自验证器那一次调用，主服务无从代签。
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("settle 的 jobId 与 SA 绑定的不一致时报错", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(OK_BODY)));
    const verifier = verifierWith(fetchImpl);
    const report = await verifier.verify(REQUEST);
    await expect(verifier.settle({ jobId: 999n, report })).rejects.toThrow(RemoteVerifierError);
  });

  it("没先 verify 就 settle 直接报错", async () => {
    const verifier = verifierWith(vi.fn<typeof fetch>());
    await expect(
      verifier.settle({
        jobId: 159_786n,
        report: { passed: true, reasonHash: `0x${"d".repeat(64)}`, outcomes: [] },
      }),
    ).rejects.toThrow(/没有对应的验证器收口结果/);
  });

  it("同一份收口结果不会被取用两次", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(OK_BODY)));
    const verifier = verifierWith(fetchImpl);
    const report = await verifier.verify(REQUEST);
    await verifier.settle({ jobId: 159_786n, report });
    await expect(verifier.settle({ jobId: 159_786n, report })).rejects.toThrow(
      RemoteVerifierError,
    );
  });

  it("网络失败带上下文重抛，且不泄露令牌", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error("ECONNREFUSED")));
    const error = await verifierWith(fetchImpl)
      .verify(REQUEST)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteVerifierError);
    expect((error as Error).message).toContain("验证器服务不可达");
    expect((error as Error).message).not.toContain("s3cr3t-token-value");
    expect((error as RemoteVerifierError).cause).toBeInstanceOf(Error);
  });

  it("非 2xx 响应报错", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)),
    );
    await expect(verifierWith(fetchImpl).verify(REQUEST)).rejects.toThrow(/401/);
  });

  it("响应不是 JSON 时报错", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("nope")));
    await expect(verifierWith(fetchImpl).verify(REQUEST)).rejects.toThrow(/有效 JSON/);
  });

  it.each([
    ["缺少 verification", { settlement: OK_BODY.settlement }],
    ["verification 形状非法", { verification: { passed: "yes" }, settlement: OK_BODY.settlement }],
    [
      "outcomes 不是数组",
      {
        verification: { passed: true, reasonHash: "0x1", outcomes: {} },
        settlement: OK_BODY.settlement,
      },
    ],
    ["缺少 settlement", { verification: OK_BODY.verification }],
    [
      "settlement.action 非法",
      { verification: OK_BODY.verification, settlement: { action: "hack", txHash: "0x1" } },
    ],
    [
      "settlement.txHash 非法",
      { verification: OK_BODY.verification, settlement: { action: "complete", txHash: 1 } },
    ],
  ])("响应形状非法被拒：%s", async (_label, body) => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(body)));
    await expect(verifierWith(fetchImpl).verify(REQUEST)).rejects.toThrow(RemoteVerifierError);
  });
});
