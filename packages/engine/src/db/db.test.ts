import { idempotencyKey } from "@citely/chain/types";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type EngineDatabase } from "./schema.js";
import { applyJobState, CaseStateError, isTerminalCaseState } from "./state.js";
import { CaseNotFoundError, CaseStore, DuplicateCaseError, PartyTaskNotFoundError } from "./store.js";
import { DuplicateIdempotencyKeyError, SqliteIdempotencyStore } from "./tx-log.js";

let db: EngineDatabase;
let store: CaseStore;

const CLOCK = (): Date => new Date("2026-07-28T00:00:00.000Z");

beforeEach(() => {
  db = openDatabase(":memory:");
  store = new CaseStore(db, CLOCK);
});

describe("applyJobState —— 链上六态穷尽映射（合约 §2.2）", () => {
  it("未终局三态不动本地状态", () => {
    for (const jobState of ["open", "funded", "submitted"] as const) {
      expect(applyJobState(jobState, false)).toEqual({ caseState: null, exitReason: null });
    }
  });

  it("completed → settled", () => {
    expect(applyJobState("completed", true)).toEqual({
      caseState: "settled",
      exitReason: "completed",
    });
  });

  it("rejected 在提交前后分属两个出口", () => {
    expect(applyJobState("rejected", false).exitReason).toBe("intake_rejected");
    expect(applyJobState("rejected", true).exitReason).toBe("verifier_rejected");
  });

  it("expired 走独立的超时出口，**不与验证器拒绝混为一谈**", () => {
    const mapping = applyJobState("expired", true);
    expect(mapping).toEqual({ caseState: "rejected", exitReason: "timeout_refund" });
    expect(mapping.exitReason).not.toBe(applyJobState("rejected", true).exitReason);
  });
});

describe("案件状态跃迁", () => {
  it("正常路径 intake → … → settled", () => {
    store.createCase("CASE-1");
    expect(store.getCase("CASE-1").state).toBe("intake");
    for (const to of ["decomposed", "assessing", "conditions_ready", "submitted", "settled"] as const) {
      expect(store.transitionCase("CASE-1", to).state).toBe(to);
    }
    expect(isTerminalCaseState("settled")).toBe(true);
  });

  it("assessing 自环合法（x402 采购后重跑）", () => {
    store.createCase("CASE-1");
    store.transitionCase("CASE-1", "decomposed");
    store.transitionCase("CASE-1", "assessing");
    expect(store.transitionCase("CASE-1", "assessing").state).toBe("assessing");
  });

  it("跳级跃迁被拒", () => {
    store.createCase("CASE-1");
    expect(() => store.transitionCase("CASE-1", "settled")).toThrow(CaseStateError);
  });

  it("终局态不可再动", () => {
    store.createCase("CASE-1");
    store.transitionCase("CASE-1", "rejected", "intake_rejected");
    expect(() => store.transitionCase("CASE-1", "assessing")).toThrow(CaseStateError);
  });

  it("重复建案报错，查不存在的案件报错", () => {
    store.createCase("CASE-1");
    expect(() => store.createCase("CASE-1")).toThrow(DuplicateCaseError);
    expect(() => store.getCase("NOPE")).toThrow(CaseNotFoundError);
    expect(store.findCase("NOPE")).toBeNull();
  });

  it("setJobId 绑定链上 Job", () => {
    store.createCase("CASE-1");
    expect(store.setJobId("CASE-1", 42n).job_id).toBe("42");
    expect(store.setJobId("CASE-1", "43").job_id).toBe("43");
  });
});

describe("reconcileJobState —— 链上只对账", () => {
  it("链上未终局时本地状态不变", () => {
    store.createCase("CASE-1");
    store.transitionCase("CASE-1", "decomposed");
    expect(store.reconcileJobState("CASE-1", "funded").state).toBe("decomposed");
  });

  it("链上 expired → 案件 rejected + timeout_refund", () => {
    store.createCase("CASE-1");
    store.transitionCase("CASE-1", "decomposed");
    store.transitionCase("CASE-1", "assessing");
    store.transitionCase("CASE-1", "conditions_ready");
    store.transitionCase("CASE-1", "submitted");
    const row = store.reconcileJobState("CASE-1", "expired");
    expect(row.state).toBe("rejected");
    expect(row.exit_reason).toBe("timeout_refund");
  });

  it("链上 completed → 案件 settled", () => {
    store.createCase("CASE-1");
    store.transitionCase("CASE-1", "decomposed");
    store.transitionCase("CASE-1", "assessing");
    store.transitionCase("CASE-1", "conditions_ready");
    store.transitionCase("CASE-1", "submitted");
    const row = store.reconcileJobState("CASE-1", "completed");
    expect(row.state).toBe("settled");
    expect(row.exit_reason).toBe("completed");
  });

  it("重复对账幂等（已是终局态则原样返回）", () => {
    store.createCase("CASE-1");
    store.transitionCase("CASE-1", "rejected", "intake_rejected");
    const row = store.reconcileJobState("CASE-1", "rejected");
    expect(row.state).toBe("rejected");
    expect(row.exit_reason).toBe("intake_rejected");
  });
});

describe("角色任务状态机", () => {
  beforeEach(() => {
    store.createCase("CASE-1");
  });

  it("pending → assessing → awaiting_data → assessing → resolved", () => {
    expect(store.createPartyTask("CASE-1", "uk_agent").state).toBe("pending");
    store.transitionPartyTask("CASE-1", "uk_agent", "assessing");
    const awaiting = store.transitionPartyTask("CASE-1", "uk_agent", "awaiting_data", {
      x402Receipt: "settlement-0x1",
    });
    expect(awaiting.x402_receipt).toBe("settlement-0x1");
    store.transitionPartyTask("CASE-1", "uk_agent", "assessing");
    const resolved = store.transitionPartyTask("CASE-1", "uk_agent", "resolved", {
      verdict: "confirmed_exempt",
    });
    expect(resolved.state).toBe("resolved");
    expect(resolved.verdict).toBe("confirmed_exempt");
  });

  it("非法跃迁被拒，resolved 是终局", () => {
    store.createPartyTask("CASE-1", "uk_agent");
    expect(() => store.transitionPartyTask("CASE-1", "uk_agent", "resolved")).toThrow(CaseStateError);
    store.transitionPartyTask("CASE-1", "uk_agent", "assessing");
    store.transitionPartyTask("CASE-1", "uk_agent", "resolved");
    expect(() => store.transitionPartyTask("CASE-1", "uk_agent", "assessing")).toThrow(
      CaseStateError,
    );
  });

  it("重复建任务幂等；查不存在的任务报错", () => {
    store.createPartyTask("CASE-1", "uk_agent");
    store.transitionPartyTask("CASE-1", "uk_agent", "assessing");
    expect(store.createPartyTask("CASE-1", "uk_agent").state).toBe("assessing");
    expect(() => store.getPartyTask("CASE-1", "nope")).toThrow(PartyTaskNotFoundError);
  });

  it("listPartyTasks 按 party 排序", () => {
    store.createPartyTask("CASE-1", "us_payer");
    store.createPartyTask("CASE-1", "uk_agent");
    expect(store.listPartyTasks("CASE-1").map((t) => t.party)).toEqual(["uk_agent", "us_payer"]);
  });
});

describe("tx_log —— IdempotencyStore", () => {
  it("lookup 未命中返回 null；record 后可读回", async () => {
    const idem = new SqliteIdempotencyStore(db);
    const key = idempotencyKey(42n, "submit");
    expect(key).toBe("42:submit");
    expect(await idem.lookup(key)).toBeNull();

    await idem.record({ key, txHash: `0x${"ab".repeat(32)}`, submittedAt: "2026-07-28T00:00:00Z" });
    expect(await idem.lookup(key)).toEqual({
      key,
      txHash: `0x${"ab".repeat(32)}`,
      submittedAt: "2026-07-28T00:00:00Z",
    });
  });

  it("同 key 重复 record 必须报错而非静默覆盖", async () => {
    const idem = new SqliteIdempotencyStore(db);
    const key = idempotencyKey("CASE-1", "createJob");
    expect(key).toBe("CASE-1:createJob");
    await idem.record({ key, txHash: `0x${"11".repeat(32)}`, submittedAt: "2026-07-28T00:00:00Z" });
    await expect(
      idem.record({ key, txHash: `0x${"22".repeat(32)}`, submittedAt: "2026-07-28T00:01:00Z" }),
    ).rejects.toThrow(DuplicateIdempotencyKeyError);
    // 原记录未被覆盖
    expect((await idem.lookup(key))?.txHash).toBe(`0x${"11".repeat(32)}`);
  });

  it("不同 action 是不同的键", async () => {
    const idem = new SqliteIdempotencyStore(db);
    await idem.record({
      key: idempotencyKey(1n, "fund"),
      txHash: `0x${"11".repeat(32)}`,
      submittedAt: "2026-07-28T00:00:00Z",
    });
    await idem.record({
      key: idempotencyKey(1n, "submit"),
      txHash: `0x${"22".repeat(32)}`,
      submittedAt: "2026-07-28T00:00:01Z",
    });
    expect(idem.list().map((r) => r.key)).toEqual(["1:fund", "1:submit"]);
  });
});
