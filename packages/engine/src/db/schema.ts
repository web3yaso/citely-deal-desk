/**
 * SQLite 表结构 —— **唯一真相源**（状态三纪律第 1 条：链上事件只用于对账，
 * 不依赖事件回放重建状态；testnet 事件流不可靠）。
 *
 * 建表语句集中在本文件，便于审查"哪些东西被持久化了"。
 * **业务内容不落库正文**：材料只留 `material_sha256`，与不变量 4 同源的纪律。
 */

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
 * 打开数据库并建表。
 *
 * @param file - 数据库文件路径；`":memory:"` 用于单测
 * @returns 已建表的连接
 */
export function openDatabase(file: string): EngineDatabase {
  const db = new Database(file);
  db.exec(SCHEMA_SQL);
  return db;
}
