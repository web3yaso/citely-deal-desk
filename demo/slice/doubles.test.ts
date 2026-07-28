import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import { createDryRunJobClient, createDryRunPaymentExecutor, DryRunStateError } from "./doubles.js";

const CLIENT = `0x${"1".repeat(40)}` as Address;
const PROVIDER = `0x${"2".repeat(40)}` as Address;
const EVALUATOR = `0x${"3".repeat(40)}` as Address;
const HASH = `0x${"4".repeat(64)}` as Hex;

function harness(): ReturnType<typeof createDryRunJobClient> {
  return createDryRunJobClient({
    client: CLIENT,
    provider: PROVIDER,
    evaluator: EVALUATOR,
    fees: { platformFeeBP: 200n, evaluatorFeeBP: 100n },
  });
}

async function openFunded(h: ReturnType<typeof createDryRunJobClient>): Promise<bigint> {
  const { jobId } = await h.client.createJob({
    caseId: "case-1",
    provider: PROVIDER,
    evaluator: EVALUATOR,
    expiredAt: 1_800_000_000n,
    description: "citely-case:case-1",
  });
  await h.client.setBudget(jobId, 3_000_000n);
  await h.client.fund(jobId, 3_000_000n);
  return jobId;
}

describe("dry-run JobClient 替身", () => {
  it("走完 createJob → setBudget → fund → submit → complete", async () => {
    const h = harness();
    const jobId = await openFunded(h);
    expect(await h.client.getJobState(jobId)).toBe("funded");
    await h.client.submit(jobId, HASH);
    expect(await h.client.getJobState(jobId)).toBe("submitted");
    await h.client.complete(jobId, HASH);
    expect(await h.client.getJobState(jobId)).toBe("completed");
    expect(h.calls.map((c) => c.action)).toEqual([
      "createJob",
      "setBudget",
      "fund",
      "submit",
      "complete",
    ]);
  });

  // 替身不检查状态的话，dry-run 会"过"、上真链才炸，排练就白排了。
  it("complete 只在 submitted 态（合约 §2.3）", async () => {
    const h = harness();
    const jobId = await openFunded(h);
    await expect(h.client.complete(jobId, HASH)).rejects.toThrow(DryRunStateError);
  });

  it("reject 在 funded 与 submitted 两态都可用", async () => {
    const fromFunded = harness();
    const a = await openFunded(fromFunded);
    await fromFunded.client.reject(a, HASH);
    expect(await fromFunded.client.getJobState(a)).toBe("rejected");

    const fromSubmitted = harness();
    const b = await openFunded(fromSubmitted);
    await fromSubmitted.client.submit(b, HASH);
    await fromSubmitted.client.reject(b, HASH);
    expect(await fromSubmitted.client.getJobState(b)).toBe("rejected");
  });

  it("claimRefund 出口态是 expired（六态里最容易漏的一个）", async () => {
    const h = harness();
    const jobId = await openFunded(h);
    await h.client.claimRefund(jobId);
    expect(await h.client.getJobState(jobId)).toBe("expired");
  });

  // 合约 §2.5：fund 前紧邻复读 budget，与预期不符即中止。
  it("fund 前复读 budget 不符 → 抛错（抢跑缓解）", async () => {
    const h = harness();
    const { jobId } = await h.client.createJob({
      caseId: "case-1",
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: 1_800_000_000n,
      description: "citely-case:case-1",
    });
    await h.client.setBudget(jobId, 9_000_000n);
    await expect(h.client.fund(jobId, 3_000_000n)).rejects.toThrow(DryRunStateError);
  });

  it("未知 jobId → 抛错", async () => {
    const h = harness();
    await expect(h.client.getJobState(99n)).rejects.toThrow(DryRunStateError);
  });

  it("费率由构造参数给出，业务代码不硬编码（合约 §2.4）", async () => {
    const h = harness();
    expect(await h.client.getFeeRates()).toEqual({ platformFeeBP: 200n, evaluatorFeeBP: 100n });
  });

  it("description 原样保留，便于审查链上 calldata", async () => {
    const h = harness();
    const jobId = await openFunded(h);
    expect((await h.client.getJob(jobId)).description).toBe("citely-case:case-1");
  });
});

describe("dry-run 付款出口", () => {
  it("只记账不转账", async () => {
    const { executor, payments } = createDryRunPaymentExecutor();
    const tx = await executor.payOut({ party: "payee", to: CLIENT, amountAtomic: 5n });
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payments).toEqual([{ party: "payee", to: CLIENT, amountAtomic: 5n }]);
  });
});
