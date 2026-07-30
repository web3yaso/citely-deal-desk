/**
 * SQLite 表结构 —— **唯一真相源**（状态三纪律第 1 条：链上事件只用于对账，
 * 不依赖事件回放重建状态；testnet 事件流不可靠）。
 *
 * 建表语句集中在本文件，便于审查"哪些东西被持久化了"。
 * **业务内容不落库正文**：材料只留 `material_sha256`，与不变量 4 同源的纪律。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

/** 一次性建表（幂等，可重复执行）。 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 案件主状态机。state 取值逐字照录合约 §3。
CREATE TABLE IF NOT EXISTS cases (
  case_id      TEXT PRIMARY KEY,
  state        TEXT NOT NULL,
  -- 终局出口（v2.2 §2.2 五出口）。非终局态为 NULL。
  -- 它与 state 分列两栏，是为了让"超时退款"与"验证器拒绝"不混成一个分支——
  -- 两者的 state 都是 rejected，但账本与对外口径完全不同。
  exit_reason  TEXT,
  -- 8183 jobId 的十进制字符串；createJob 之前为 NULL。
  job_id       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 角色任务状态机（合约 §3 partyTask）。
CREATE TABLE IF NOT EXISTS party_tasks (
  case_id       TEXT NOT NULL REFERENCES cases(case_id),
  party         TEXT NOT NULL,
  state         TEXT NOT NULL,
  -- awaiting_data 态的 x402 结算回执 ID（合约 §3 的 awaiting_data(x402_receipt)）。
  x402_receipt  TEXT,
  -- resolved 态的判定结果（合约 §3 的 resolved(verdict)）。
  verdict       TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (case_id, party)
);

-- 链上写操作幂等表：实现 chain 的 IdempotencyStore（合约 §3）。
-- key 由 chain 导出的 idempotencyKey() 构造，engine 不自己拼字符串。
CREATE TABLE IF NOT EXISTS tx_log (
  key           TEXT PRIMARY KEY,
  tx_hash       TEXT NOT NULL,
  submitted_at  TEXT NOT NULL
);

-- 账本（**v2.3 §3.5**）。amount_* 是 6 位小数最小单位的十进制字符串
-- （SQLite 的 INTEGER 是 64 位有符号，USDC 金额虽然放得下，
--  但用字符串存可以让"最小单位 bigint"这条纪律在读写两端都不被 number 污染）。
CREATE TABLE IF NOT EXISTS ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id         TEXT,
  direction       TEXT NOT NULL,
  amount_nominal  TEXT NOT NULL,
  amount_actual   TEXT NOT NULL,
  -- v2.3 破坏性变更：原 job_id + tx_hash 两列合并为 ref + ref_type 三态。
  -- Gateway 批量结算下，module_fee 发生那一刻只有回执没有 txHash，
  -- 旧结构只能填假值——账本里的假值比缺值危险。
  ref             TEXT NOT NULL,
  ref_type        TEXT NOT NULL CHECK (ref_type IN ('jobId','gateway_receipt','txHash')),
  category        TEXT NOT NULL,
  -- 记账主体（operator/verifier/procurement/escrow）。不是 §3.5 字段，
  -- 但一次 complete 会给运营与验证器两个钱包各产生一笔进账（合约 §2.4），
  -- 没有这一列就区分不开、也做不了幂等约束。
  account         TEXT NOT NULL,
  -- 批量结算后补挂的链上结算 tx（gateway_receipt 行专用），未结算为 NULL。
  settlement_tx   TEXT,
  recorded_at     TEXT NOT NULL,
  -- 同一笔收支对同一主体只许入账一次（幂等：重试不重复记账）。
  UNIQUE (ref, ref_type, category, direction, account)
);

-- 判定溯源（llm-provider-openai.md §7 第 4 组：provenance 落 SQLite）。
CREATE TABLE IF NOT EXISTS adjudications (
  case_id     TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  confidence  TEXT NOT NULL,
  gray_type   TEXT,
  risk_flags  TEXT NOT NULL,
  cache_key   TEXT NOT NULL,
  cache_hit   INTEGER NOT NULL,
  model       TEXT NOT NULL,
  repairs     TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (case_id, item_id)
);
`;

/** better-sqlite3 的连接类型别名（避免各处重复写 `Database.Database`）。 */
export type EngineDatabase = Database.Database;

/**
 * 表结构版本，存进 SQLite 的 `PRAGMA user_version`。
 *
 * **改表结构必须 +1**。它的用途不是做增量迁移（黑客松阶段不值得），
 * 而是让"用旧库跑新代码"**响亮失败**：`CREATE TABLE IF NOT EXISTS` 对一个
 * 已存在但缺列的表什么都不做，于是旧库配新代码会在运行到那一列时才炸，
 * 或者更糟——静默少记一个字段。彩排要求每次冷启动，这个守卫就是那条要求的执行者。
 */
export const SCHEMA_VERSION = 1;

/** 库里的表结构版本与代码不符。 */
export class SchemaVersionError extends Error {
  public constructor(found: number, expected: number, file: string) {
    super(
      `database schema version mismatch: found ${String(found)}, expected ${String(expected)} (${file}). ` +
        `This database was created by a different version of the code. ` +
        `Cold-start it: pnpm -F @citely/engine db:reset (or pass { fresh: true }).`,
    );
    this.name = "SchemaVersionError";
  }
}

export interface OpenDatabaseOptions {
  /**
   * 冷启动：先把所有表删掉再建，得到一个空库。
   * 彩排要求"每次从空数据库冷启动验证幂等"（《模块拆分》§三 D6）。
   */
  readonly fresh?: boolean;
}

/** 列出用户表（排除 SQLite 内部表）。 */
function listTables(db: EngineDatabase): readonly string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { readonly name: string }[];
  return rows.map((r) => r.name);
}

/**
 * 删掉全部用户表。
 *
 * 用"删表"而不是"删文件"：`:memory:` 没有文件、WAL 还会留下 `-wal`/`-shm` 兄弟文件，
 * 删文件容易删漏；而且删表走的是同一个连接，不存在"文件被占用"的平台差异。
 */
function dropAllTables(db: EngineDatabase): void {
  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    for (const table of listTables(db)) {
      // 表名来自 sqlite_master，不是外部输入；仍用引号包住防怪异表名。
      db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
  });
  tx();
  db.pragma("foreign_keys = ON");
}

function readUserVersion(db: EngineDatabase): number {
  const result = db.pragma("user_version", { simple: true });
  return typeof result === "number" ? result : 0;
}

/**
 * 打开数据库并建表（**冷启动即可用，不需要任何手工建表步骤**）。
 *
 * 行为：
 * 1. 自动创建父目录——`DB_PATH` 默认是 `./data/deal-desk.sqlite`，
 *    新克隆的仓库里 `data/` 不存在，不建目录 better-sqlite3 直接抛
 *    `SQLITE_CANTOPEN`。这是冷启动路径上最容易被漏掉的一步，因为开发机上
 *    那个目录早就存在了；
 * 2. `fresh` 时先清库；
 * 3. 空库 → 建表并写入 {@link SCHEMA_VERSION}；
 * 4. 非空库 → 校验版本，不符则抛 {@link SchemaVersionError}。
 *
 * @param file - 数据库文件路径；`":memory:"` 用于单测
 * @param options - `fresh` 为冷启动
 * @returns 已建表的连接
 * @throws {SchemaVersionError} 既有库的表结构版本与代码不符
 */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): EngineDatabase {
  if (file !== ":memory:" && !file.startsWith("file:")) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new Database(file);
  if (options.fresh === true) dropAllTables(db);

  const existingTables = listTables(db);
  if (existingTables.length === 0) {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
    return db;
  }

  const found = readUserVersion(db);
  if (found !== SCHEMA_VERSION) {
    db.close();
    throw new SchemaVersionError(found, SCHEMA_VERSION, file);
  }
  // 版本相符：仍跑一遍 DDL，让"新增表"这种纯追加变更不必 bump 版本。
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * 清库（彩排冷启动用）。等价于 `openDatabase(file, { fresh: true })`，
 * 但语义直白，且返回被删掉的表名便于打印。
 *
 * @returns 被删掉的表名（按字母序）
 */
export function resetDatabase(file: string): readonly string[] {
  if (file !== ":memory:" && !file.startsWith("file:")) {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  const dropped = [...listTables(db)].sort();
  dropAllTables(db);
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
  db.close();
  return dropped;
}
