import type { CreateJobParams, CreateJobResult, JobClient, JobState } from "@citely/chain";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import { buildReason, reasonHash } from "./reason.js";
import {
  COMPLETE_ALLOWED_STATES,
  EVALUATOR_REJECT_ALLOWED_STATES,
  settleVerifiedJob,
  SettlementStateError,
} from "./settle.js";
import type { VerificationReport } from "./verify.js";

const SA_HASH = `0x${"11".repeat(32)}` as Hex;
const TX_COMPLETE = `0x${"aa".repeat(32)}` as Hex;
const TX_REJECT = `0x${"bb".repeat(32)}` as Hex;

/** 记录调用的假 JobClient——单测零网络：不发任何交易。 */
function fakeJobClient(state: JobState): {
  readonly client: JobClient;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const notUsed = (name: string): never => {
    throw new Error(`settle must not call ${name}`);
  };
  const client: JobClient = {
    createJob: (_p: CreateJobParams): Promise<CreateJobResult> => notUsed("createJob"),
    setBudget: () => notUsed("setBudget"),
    fund: () => notUsed("fund"),
    submit: () => notUsed("submit"),
    complete: (jobId, hash) => {
      calls.push(`complete:${String(jobId)}:${hash}`);
      return Promise.resolve(TX_COMPLETE);
    },
    reject: (jobId, hash) => {
      calls.push(`reject:${String(jobId)}:${hash}`);
      return Promise.resolve(TX_REJECT);
    },
    claimRefund: () => notUsed("claimRefund"),
    getJob: () => notUsed("getJob"),
    getFeeRates: () => notUsed("getFeeRates"),
    getJobState: () => Promise.resolve(state),
  };
  return { client, calls };
}

function report(passed: boolean): VerificationReport {
  const reason = buildReason({
    saHash: SA_HASH,
    jobId: "7",
    outcomes: [
      { check: "deliverable_signature", passed, failures: passed ? [] : [{ code: "boom" }] },
      { check: "module_attestation", passed: true, failures: [] },
      { check: "rubric_coverage", passed: true, failures: [] },
    ],
  });
  return { passed, outcomes: [], saHash: SA_HASH, reason, reasonHash: reasonHash(reason) };
}

describe("settleVerifiedJob（合约 §2.3 状态与授权矩阵）", () => {
  it("三检全过 + Submitted 态 → complete，上链的是 reasonHash 不是明文", async () => {
    const { client, calls } = fakeJobClient("submitted");
    const rep = report(true);
    const action = await settleVerifiedJob({ jobClient: client, jobId: 7n, report: rep });

    expect(action).toEqual({
      action: "complete",
      jobId: 7n,
      reasonHash: rep.reasonHash,
      txHash: TX_COMPLETE,
    });
    expect(calls).toEqual([`complete:7:${rep.reasonHash}`]);
    // 不变量 4：上链参数必须是 32 字节哈希。
    expect(rep.reasonHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // T-fix3 的核心：Funded 与 Submitted 两态都要能 reject。
  for (const state of ["funded", "submitted"] as const) {
    it(`受理失败 + ${state} 态 → reject`, async () => {
      const { client, calls } = fakeJobClient(state);
      const rep = report(false);
      const action = await settleVerifiedJob({ jobClient: client, jobId: 7n, report: rep });

      expect(action.action).toBe("reject");
      expect(action.txHash).toBe(TX_REJECT);
      expect(calls).toEqual([`reject:7:${rep.reasonHash}`]);
    });
  }

  it("Open 态 reject 是 client 的权限，验证器抛错中止", async () => {
    const { client, calls } = fakeJobClient("open");
    await expect(
      settleVerifiedJob({ jobClient: client, jobId: 7n, report: report(false) }),
    ).rejects.toThrow(SettlementStateError);
    expect(calls).toEqual([]);
  });

  it("终态（completed/rejected/expired）不再收口", async () => {
    // expired 是 claimRefund 后的终态（合约 §2.2，六态里最容易被漏掉的一个）。
    for (const state of ["completed", "rejected", "expired"] as const) {
      const { client, calls } = fakeJobClient(state);
      await expect(
        settleVerifiedJob({ jobClient: client, jobId: 7n, report: report(false) }),
      ).rejects.toThrow(SettlementStateError);
      expect(calls).toEqual([]);
    }
  });

  it("三检全过但不在 Submitted 态 → 抛错，绝不试发交易", async () => {
    const { client, calls } = fakeJobClient("funded");
    await expect(
      settleVerifiedJob({ jobClient: client, jobId: 7n, report: report(true) }),
    ).rejects.toThrow(SettlementStateError);
    expect(calls).toEqual([]);
  });

  it("错误带上 jobId 与实际状态，便于运营定位（不吞错）", async () => {
    const { client } = fakeJobClient("open");
    try {
      await settleVerifiedJob({ jobClient: client, jobId: 42n, report: report(false) });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SettlementStateError);
      const e = err as SettlementStateError;
      expect(e.jobId).toBe(42n);
      expect(e.state).toBe("open");
      expect(e.message).toContain("open");
    }
  });

  it("允许状态常量与合约 §2.3 逐条一致", () => {
    expect(COMPLETE_ALLOWED_STATES).toEqual(["submitted"]);
    expect(EVALUATOR_REJECT_ALLOWED_STATES).toEqual(["funded", "submitted"]);
  });
});
