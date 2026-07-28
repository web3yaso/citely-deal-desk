/**
 * 账本落盘（表结构见 `db/schema.ts`）。
 *
 * 金额在 SQLite 里存**十进制字符串**：JS 的 `number` 放不下也不该碰原子单位金额，
 * 而 better-sqlite3 的 bigint 支持要开全局开关。读回时立刻转回 `bigint`，
 * 让"金额一律 6 位小数原子单位 bigint"这条纪律在读写两端都成立。
 */

import type { EngineDatabase } from "../db/schema.js";
import type { LedgerCategory, LedgerEntry } from "./types.js";

/** 同一笔链上动作被重复入账。 */
export class DuplicateLedgerEntryError extends Error {
  public constructor(txHash: string, category: string, account: string) {
    super(`ledger entry already recorded: ${txHash}/${category}/${account}`);
    this.name = "DuplicateLedgerEntryError";
  }
}

interface LedgerRow {
  readonly case_id: string | null;
  readonly direction: string;
  readonly amount_nominal: string;
  readonly amount_actual: string;
  readonly job_id: string | null;
  readonly tx_hash: string;
  readonly category: string;
  readonly account: string;
  readonly recorded_at: string;
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    direction: row.direction as LedgerEntry["direction"],
    amount_nominal: BigInt(row.amount_nominal),
    amount_actual: BigInt(row.amount_actual),
    jobId: row.job_id === null ? null : BigInt(row.job_id),
    txHash: row.tx_hash,
    category: row.category as LedgerCategory,
    account: row.account as LedgerEntry["account"],
    caseId: row.case_id,
  };
}

/** 账本仓储。 */
export class LedgerStore {
  private readonly db: EngineDatabase;
  private readonly clock: () => Date;

  public constructor(db: EngineDatabase, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * 入账。
   *
   * @throws {DuplicateLedgerEntryError} 同 `(txHash, category, account, direction)` 已入账
   *   —— 全链路幂等（状态三纪律第 3 条）：重试不重复记账
   */
  public record(entry: LedgerEntry): void {
    const changes = this.db
      .prepare(
        `INSERT OR IGNORE INTO ledger
           (case_id, direction, amount_nominal, amount_actual, job_id, tx_hash,
            category, account, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.caseId,
        entry.direction,
        entry.amount_nominal.toString(),
        entry.amount_actual.toString(),
        entry.jobId === null ? null : entry.jobId.toString(),
        entry.txHash,
        entry.category,
        entry.account,
        this.clock().toISOString(),
      );
    if (changes.changes === 0) {
      throw new DuplicateLedgerEntryError(entry.txHash, entry.category, entry.account);
    }
  }

  /** 批量入账（任意一条重复即整批回滚）。 */
  public recordAll(entries: readonly LedgerEntry[]): void {
    const tx = this.db.transaction((batch: readonly LedgerEntry[]) => {
      for (const entry of batch) this.record(entry);
    });
    tx(entries);
  }

  /** 列出账本，可按案件过滤。顺序按插入序，便于人读 P&L。 */
  public list(caseId?: string): readonly LedgerEntry[] {
    const rows =
      caseId === undefined
        ? (this.db.prepare(`SELECT * FROM ledger ORDER BY id`).all() as LedgerRow[])
        : (this.db
            .prepare(`SELECT * FROM ledger WHERE case_id = ? ORDER BY id`)
            .all(caseId) as LedgerRow[]);
    return rows.map(toEntry);
  }

  /** 按 `amount_actual` 算净额（in 为正、out 为负）。 */
  public netActual(caseId?: string): bigint {
    return this.list(caseId).reduce(
      (acc, entry) => (entry.direction === "in" ? acc + entry.amount_actual : acc - entry.amount_actual),
      0n,
    );
  }
}
