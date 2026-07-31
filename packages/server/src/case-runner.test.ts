import { usdc6 } from "@citely/engine";
import type { CaseRequest, RunCaseDeps } from "@citely/engine/orchestrator";
import type { LoadedRubric } from "@citely/engine/rubric";
import { describe, expect, it, vi } from "vitest";

import { createCaseRunner, toCaseRequest } from "./case-runner.js";
import type { CaseRunnerConfig, RunCaseFn } from "./case-runner.js";
import type { RunCaseRequest, RunCaseResult } from "./ports.js";

const CONFIG: CaseRunnerConfig = {
  provider: "0x0000000000000000000000000000000000000A11",
  evaluator: "0x0000000000000000000000000000000000000B22",
  caseBudget: usdc6(3_000_000n),
  moduleId: "us-msb",
  modulePrice: usdc6(800_000n),
  chainId: 5_042_002,
  rubric: { id: "demo" } as LoadedRubric,
};

const REQUEST: RunCaseRequest = {
  deal: {
    deal_id: "case-001",
    parties: [{ role: "payer", country: "US" }],
    activity: "money_transmission",
    amount_usdc: 12_500,
    evidence: {},
  },
  settlement: {
    party: "uk_service_agent",
    payee: "0x000000000000000000000000000000000000bEEF",
    amountAtomic: usdc6(12_500_000_000n),
  },
  expiresAt: new Date("2026-12-31T00:00:00.000Z"),
};

describe("toCaseRequest", () => {
  it("deal_id 即案件幂等键", () => {
    expect(toCaseRequest(REQUEST, CONFIG).caseId).toBe("case-001");
  });

  it("服务侧参数来自配置，不由调用方指定", () => {
    const result = toCaseRequest(REQUEST, CONFIG);
    expect(result.job.provider).toBe(CONFIG.provider);
    expect(result.job.evaluator).toBe(CONFIG.evaluator);
    expect(result.job.budgetAtomic).toBe(CONFIG.caseBudget);
    expect(result.module).toEqual({ id: "us-msb", quotedPriceAtomic: CONFIG.modulePrice });
    expect(result.chainId).toBe(5_042_002);
    expect(result.rubric).toBe(CONFIG.rubric);
  });

  it("请求侧参数原样透传，服务端不替调用方猜", () => {
    const result = toCaseRequest(REQUEST, CONFIG);
    expect(result.settlement).toEqual({
      party: "uk_service_agent",
      payee: "0x000000000000000000000000000000000000bEEF",
      amountAtomic: 12_500_000_000n,
    });
    expect(result.deal).toBe(REQUEST.deal);
  });

  it("到期时刻换算成 Unix 秒（8183 的 expiredAt 是秒）", () => {
    expect(toCaseRequest(REQUEST, CONFIG).job.expiredAt).toBe(
      BigInt(Math.floor(Date.parse("2026-12-31T00:00:00.000Z") / 1000)),
    );
  });

  it("同一请求翻译两次结果一致（sa_hash 可复现的前提）", () => {
    expect(toCaseRequest(REQUEST, CONFIG)).toEqual(toCaseRequest(REQUEST, CONFIG));
  });
});

describe("createCaseRunner", () => {
  it("把翻译后的入参与依赖交给 runCase", async () => {
    const result = { caseId: "case-001" } as RunCaseResult;
    const runCase = vi.fn<RunCaseFn>(() => Promise.resolve(result));
    const deps = { marker: true } as unknown as RunCaseDeps;

    const actual = await createCaseRunner(runCase, deps, CONFIG).runCase(REQUEST);

    expect(actual).toBe(result);
    const [caseRequest, passedDeps] = runCase.mock.calls[0] as [CaseRequest, RunCaseDeps];
    expect(caseRequest.caseId).toBe("case-001");
    expect(passedDeps).toBe(deps);
  });
});
