/**
 * 彩排冷启动与幂等的实证（《模块拆分》§三 D6：**每次从空数据库冷启动验证幂等**）。
 *
 * 这组测试用**真实文件库**而不是 `:memory:`——冷启动路径上出问题的地方
 * （父目录不存在、旧库残留、重开连接后幂等失效）全都只在文件库上才存在。
 * 用内存库测冷启动，是在测一个不会发生的场景。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { idempotencyKey } from "@citely/chain/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entriesForComplete } from "../ledger/entries.js";
import { LedgerStore } from "../ledger/store.js";
import { usdc6FromDecimal } from "../util/usdc6.js";
import { openDatabase, resetDatabase, SCHEMA_VERSION, SchemaVersionError } from "./schema.js";
import { CaseStore } from "./store.js";
import { SqliteIdempotencyStore } from "./tx-log.js";

const EXPECTED_TABLES = [
  "adjudications",
  "case_runs",
  "cases",
  "ledger",
  "party_tasks",
  "purchases",
  "tx_log",
] as const;

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "citely-coldstart-"));
  // 刻意指向一个**尚不存在的子目录**，模拟新克隆仓库里没有 data/ 的情形。
  dbPath = join(tmp, "data", "deal-desk.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tableNames(db: ReturnType<typeof openDatabase>): readonly string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { readonly name: string }[];
  return [...rows.map((r) => r.name)].sort();
}

describe("从零建库：不需要任何手工建表步骤", () => {
  it("父目录不存在也能建库（新克隆仓库里 data/ 不存在）", () => {
    expect(existsSync(join(tmp, "data"))).toBe(false);
    const db = openDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  it("七张表一次建齐", () => {
    const db = openDatabase(dbPath);
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES]);
    db.close();
  });

  it("写入 schema 版本，供后续启动校验", () => {
    const db = openDatabase(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("重复打开同一个库不报错、不丢数据（进程重启场景）", () => {
    const first = openDatabase(dbPath);
    new CaseStore(first).createCase("CASE-1");
    first.close();

    const second = openDatabase(dbPath);
    expect(new CaseStore(second).getCase("CASE-1").state).toBe("intake");
    second.close();
  });
});

describe("旧库配新代码必须响亮失败（不许静默少列）", () => {
  it("user_version 不符时抛 SchemaVersionError 并给出可执行的修复指令", () => {
    const db = openDatabase(dbPath);
    // 模拟"这个库是另一个版本的代码建的"。
    db.pragma(`user_version = ${String(SCHEMA_VERSION + 1)}`);
    db.close();

    let caught: unknown;
    try {
      openDatabase(dbPath);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaVersionError);
    expect((caught as Error).message).toContain("db:reset");
  });

  it("上一版代码建的库（user_version 从未写过 = 0）也被判为陈旧", () => {
    const db = openDatabase(dbPath);
    db.pragma("user_version = 0");
    db.close();
    expect(() => openDatabase(dbPath)).toThrow(SchemaVersionError);
  });
});

describe("fresh / resetDatabase：彩排的清库入口", () => {
  it("fresh 把既有数据清空，表重新建齐", () => {
    const first = openDatabase(dbPath);
    new CaseStore(first).createCase("CASE-1");
    first.close();

    const fresh = openDatabase(dbPath, { fresh: true });
    expect(tableNames(fresh)).toEqual([...EXPECTED_TABLES]);
    expect(new CaseStore(fresh).findCase("CASE-1")).toBeNull();
    fresh.close();
  });

  it("resetDatabase 返回被删掉的表名（彩排的可见证据）", () => {
    openDatabase(dbPath).close();
    expect(resetDatabase(dbPath)).toEqual([...EXPECTED_TABLES]);
  });

  it("对空库/不存在的库调用 reset 也安全，返回空列表", () => {
    expect(resetDatabase(join(tmp, "never", "existed.sqlite"))).toEqual([]);
  });

  it("fresh 能把陈旧版本的库救回来（这就是报错信息里让人做的事）", () => {
    const db = openDatabase(dbPath);
    db.pragma(`user_version = ${String(SCHEMA_VERSION + 1)}`);
    db.close();
    expect(() => openDatabase(dbPath)).toThrow(SchemaVersionError);
    // 按报错提示清库后即可正常打开。
    resetDatabase(dbPath);
    const recovered = openDatabase(dbPath);
    expect(recovered.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    recovered.close();
  });
});

describe("同一案件重跑不重复付款（幂等键 jobId+action 跨进程生效）", () => {
  const TX = `0x${"ab".repeat(32)}` as const;

  it("第二次运行时 lookup 命中既有 txHash，chain 据此不重发交易", async () => {
    const first = openDatabase(dbPath);
    const key = idempotencyKey(42n, "fund");
    await new SqliteIdempotencyStore(first).record({
      key,
      txHash: TX,
      submittedAt: "2026-07-29T00:00:00Z",
    });
    first.close();

    // ——进程重启——
    const second = openDatabase(dbPath);
    const hit = await new SqliteIdempotencyStore(second).lookup(key);
    expect(hit?.txHash).toBe(TX);
    second.close();
  });

  it("重跑时重复 record 同一键报错，不会静默覆盖成第二笔交易", async () => {
    const db = openDatabase(dbPath);
    const store = new SqliteIdempotencyStore(db);
    const key = idempotencyKey(42n, "complete");
    await store.record({ key, txHash: TX, submittedAt: "2026-07-29T00:00:00Z" });
    await expect(
      store.record({ key, txHash: `0x${"cd".repeat(32)}`, submittedAt: "2026-07-29T00:01:00Z" }),
    ).rejects.toThrow();
    expect((await store.lookup(key))?.txHash).toBe(TX);
    db.close();
  });

  it("账本重跑不产生重复行（P&L 数字不会翻倍）", () => {
    const params = {
      caseId: "CASE-1",
      jobId: 42n,
      budget: usdc6FromDecimal("10.00"),
      fees: { platformFeeBP: 250n, evaluatorFeeBP: 100n },
    };

    const first = openDatabase(dbPath);
    new LedgerStore(first).recordAll(entriesForComplete(params));
    first.close();

    const second = openDatabase(dbPath);
    const ledger = new LedgerStore(second);
    // 第二次运行尝试记同一批账 —— 必须被幂等键挡住。
    expect(() => {
      ledger.recordAll(entriesForComplete(params));
    }).toThrow();
    expect(ledger.list("CASE-1")).toHaveLength(2);
    expect(ledger.netActual("CASE-1")).toBe(9_650_000n + 100_000n);
    second.close();
  });

  it("冷启动后账本从零开始（彩排每次都是干净数字）", () => {
    const params = {
      caseId: "CASE-1",
      jobId: 42n,
      budget: usdc6FromDecimal("10.00"),
      fees: { platformFeeBP: 250n, evaluatorFeeBP: 100n },
    };
    const first = openDatabase(dbPath);
    new LedgerStore(first).recordAll(entriesForComplete(params));
    first.close();

    const fresh = openDatabase(dbPath, { fresh: true });
    const ledger = new LedgerStore(fresh);
    expect(ledger.list()).toHaveLength(0);
    // 清库之后同一批账可以重新记一次，不再被幂等键挡住。
    expect(() => {
      ledger.recordAll(entriesForComplete(params));
    }).not.toThrow();
    expect(ledger.list("CASE-1")).toHaveLength(2);
    fresh.close();
  });
});
