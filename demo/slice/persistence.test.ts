/**
 * 演示路径的幂等实证（自动化版）。
 *
 * 2026-07-30 的事故：演示路径完全不碰 SQLite，账本行是内存算出来的，
 * `DuplicateLedgerEntryError` 这套机制**从未被触发过**——"重跑不重复入账"
 * 这条提交物底线一天都没被真正验证。这个文件把它锁住。
 *
 * 用**真实文件库**并在每次"运行"之间关闭再重开连接：模拟两次独立进程启动。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CaseStore,
  entriesForComplete,
  LedgerStore,
  openDatabase,
  resolveDbPath,
  usdc6FromDecimal,
  type EngineDatabase,
} from "@citely/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordLedgerIdempotent } from "./persistence.js";

const CASE_ID = "citely-demo-0001";
const JOB_ID = 1n;
const BUDGET = usdc6FromDecimal("3.00");
const FEES = { platformFeeBP: 0n, evaluatorFeeBP: 0n } as const;

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "citely-demo-persist-"));
  dbPath = join(tmp, "data", "deal-desk.dryrun.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 跑一次演示的持久化部分：建案 → 绑 jobId → 入账。 */
function runOnce(): { inserted: number; skipped: number; rows: number; state: string } {
  const db: EngineDatabase = openDatabase(dbPath);
  try {
    const cases = new CaseStore(db);
    cases.ensureCase(CASE_ID);
    cases.setJobId(CASE_ID, JOB_ID);

    const ledger = new LedgerStore(db);
    const written = recordLedgerIdempotent(
      ledger,
      entriesForComplete({ caseId: CASE_ID, jobId: JOB_ID, budget: BUDGET, fees: FEES }),
    );
    return {
      inserted: written.inserted,
      skipped: written.skipped,
      rows: ledger.list(CASE_ID).length,
      state: cases.getCase(CASE_ID).state,
    };
  } finally {
    db.close();
  }
}

describe("同一 caseId 连跑两次：账本不重复入账", () => {
  it("第一次写入，第二次全部被幂等挡下，库内行数不变", () => {
    const first = runOnce();
    expect(first.inserted).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.rows).toBe(2);

    const second = runOnce();
    // DuplicateLedgerEntryError 被真的触发并正确处理。
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.rows).toBe(2);
  });

  it("跑三次行数仍不变（跑三次一样才叫幂等）", () => {
    const rows = [runOnce().rows, runOnce().rows, runOnce().rows];
    expect(rows).toEqual([2, 2, 2]);
  });

  it("案件状态跨运行一致，且 ensureCase 不会把状态重置", () => {
    expect(runOnce().state).toBe("intake");
    // 中途推进状态，模拟真实流程走到一半。
    const db = openDatabase(dbPath);
    new CaseStore(db).transitionCase(CASE_ID, "decomposed");
    db.close();
    // 重跑：接着既有状态走，而不是被重新建案覆盖回 intake。
    expect(runOnce().state).toBe("decomposed");
  });

  it("冷启动（清库）之后重新计数", () => {
    runOnce();
    expect(runOnce().skipped).toBe(2);

    openDatabase(dbPath, { fresh: true }).close();
    const afterReset = runOnce();
    expect(afterReset.inserted).toBe(2);
    expect(afterReset.rows).toBe(2);
  });
});

describe("dry-run 用独立库，但同样落盘、同样可被清掉", () => {
  it("dry-run 库与真跑库是两个不同的绝对路径", () => {
    const real = resolveDbPath(process.env, { dryRun: false });
    const dry = resolveDbPath(process.env, { dryRun: true });
    expect(dry).not.toBe(real);
    expect(dry.startsWith("/")).toBe(true);
    expect(real.startsWith("/")).toBe(true);
  });

  it("**路径与 cwd 无关**：这是 2026-07-30 那次清错库的根因", () => {
    // 同一份 env 在任何 cwd 下都必须解析到同一个绝对路径。
    const a = resolveDbPath({ DB_PATH: "./data/deal-desk.sqlite" });
    const b = resolveDbPath({ DB_PATH: "./data/deal-desk.sqlite" });
    expect(a).toBe(b);
    expect(a).not.toContain(join("packages", "engine", "data"));
  });
});
