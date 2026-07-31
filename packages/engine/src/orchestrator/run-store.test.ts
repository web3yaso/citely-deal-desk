/**
 * 请求级幂等的单测：这是"同一请求重发两次"的第一道闸，它错了后面三层都白搭。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type EngineDatabase } from "../db/schema.js";
import {
  CaseRequestConflictError,
  CaseRunInFlightError,
  CaseRunSnapshotError,
  CaseRunStore,
} from "./run-store.js";
import type { CaseRunSnapshot } from "./types.js";

const CASE_ID = "citely-demo-0001";
const HASH = "a".repeat(64);

/** 快照只需字段齐全到能被 `parseSnapshot` 接受；其余字段单测里不看。 */
function snapshot(over: Partial<CaseRunSnapshot> = {}): CaseRunSnapshot {
  return {
    caseId: CASE_ID,
    jobId: "7",
    routing: { exit: "high_confidence", chainAction: "submit", actor: "operator", reason: "ok" },
    saHash: `0x${"cd".repeat(32)}`,
    adjudication: [],
    verification: { passed: true, reasonHash: `0x${"ef".repeat(32)}`, outcomes: [] },
    settlement: { action: "complete", txHash: `0x${"11".repeat(32)}` },
    procurement: { settlementId: "gw-1", paidAtomic: "800000", reused: false },
    briefingPack: null,
    // SA 正文在这条链路上只被原样搬运，单测用最小占位对象即可。
    sa: { placeholder: true } as unknown as CaseRunSnapshot["sa"],
    ...over,
  };
}

describe("CaseRunStore", () => {
  let db: EngineDatabase;
  let store: CaseRunStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new CaseRunStore(db);
  });

  it("首次申请 → started", () => {
    expect(store.begin(CASE_ID, HASH)).toEqual({ kind: "started" });
    expect(store.get(CASE_ID).status).toBe("running");
  });

  it("成功后同请求重发 → replay，返回上次快照", () => {
    store.begin(CASE_ID, HASH);
    store.succeed(CASE_ID, snapshot());

    const again = store.begin(CASE_ID, HASH);
    expect(again.kind).toBe("replay");
    if (again.kind !== "replay") throw new Error("expected replay");
    expect(again.snapshot.jobId).toBe("7");
    expect(again.snapshot.saHash).toBe(`0x${"cd".repeat(32)}`);
  });

  it("同 caseId 换了请求参数 → 冲突，绝不覆盖既有案件", () => {
    store.begin(CASE_ID, HASH);
    store.succeed(CASE_ID, snapshot());

    expect(() => store.begin(CASE_ID, "b".repeat(64))).toThrow(CaseRequestConflictError);
  });

  it("正在跑且未陈旧 → in-flight（跨进程的那一半幂等）", () => {
    store.begin(CASE_ID, HASH);
    expect(() => store.begin(CASE_ID, HASH)).toThrow(CaseRunInFlightError);
  });

  it("running 超过 staleRunMs → 允许接管重跑，不把 caseId 永久锁死", () => {
    let now = new Date("2026-07-30T00:00:00.000Z");
    const stale = new CaseRunStore(db, { clock: () => now, staleRunMs: 60_000 });
    stale.begin(CASE_ID, HASH);

    now = new Date("2026-07-30T00:02:00.000Z");
    expect(stale.begin(CASE_ID, HASH)).toEqual({ kind: "resumed", previousError: null });
  });

  it("上次失败 → 允许重跑，并带上上次的失败原因", () => {
    store.begin(CASE_ID, HASH);
    store.fail(CASE_ID, "ChainError: rpc timeout");

    expect(store.begin(CASE_ID, HASH)).toEqual({
      kind: "resumed",
      previousError: "ChainError: rpc timeout",
    });
    expect(store.get(CASE_ID).status).toBe("running");
  });

  it("快照坏了要响亮失败，不静默当作未命中（那会导致重跑重复建 Job）", () => {
    store.begin(CASE_ID, HASH);
    db.prepare(`UPDATE case_runs SET status = 'succeeded', snapshot_json = ? WHERE case_id = ?`).run(
      "{not json",
      CASE_ID,
    );

    expect(() => store.begin(CASE_ID, HASH)).toThrow(CaseRunSnapshotError);
  });

  it("标成功却没有快照也要响亮失败", () => {
    store.begin(CASE_ID, HASH);
    db.prepare(`UPDATE case_runs SET status = 'succeeded' WHERE case_id = ?`).run(CASE_ID);

    expect(() => store.begin(CASE_ID, HASH)).toThrow(CaseRunSnapshotError);
  });

  it("find 对不存在的案件返回 null（服务查询接口用）", () => {
    expect(store.find("nope")).toBeNull();
  });
});
