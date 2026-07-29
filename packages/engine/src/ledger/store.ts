/**
 * 账本落盘（表结构见 `db/schema.ts`）。
 *
 * 金额在 SQLite 里存**十进制字符串**：JS 的 `number` 放不下也不该碰最小单位金额，
 * 而 better-sqlite3 的 bigint 支持要开全局开关。读回时立刻过 `usdc6FromAtomicString`，
 * 让"金额一律 6 位小数最小单位"这条纪律在读写两端都成立（v2.3 §9）。
 */

import type { EngineDatabase } from "../db/schema.js";
import { usdc6FromAtomicString, usdc6ToAtomicString } from "../util/usdc6.js";
import type { Usdc6 } from "../util/usdc6.js";
import type { LedgerCategory, LedgerEntry, LedgerRefType } from "./types.js";

/** 同一笔收支被重复入账。 */
export class DuplicateLedgerEntryError extends Error {
  public constructor(ref: string, category: string, account: string) {
    super(`ledger entry already recorded: ${ref}/${category}/${account}`);
    this.name = "DuplicateLedgerEntryError";
  }
}

/** 要补挂结算 tx 的行不存在，或它不是 `gateway_receipt` 行。 */
export class SettlementAttachError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SettlementAttachError";
  }
}

interface LedgerRow {
  readonly case_id: string | null;
  readonly direction: string;
  readonly amount_nominal: string;
  readonly amount_actual: string;
  readonly ref: string;
  readonly ref_type: string;
  readonly category: string;
  readonly account: string;
  readonly settlement_tx: string | null;
  readonly recorded_at: string;
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    direction: row.direction as LedgerEntry["direction"],
    amount_nominal: usdc6FromAtomicString(row.amount_nominal),
    amount_actual: usdc6FromAtomicString(row.amount_actual),
    ref: row.ref,
    ref_type: row.ref_type as LedgerRefType,
    category: row.category as LedgerCategory,
    account: row.account as LedgerEntry["account"],
    caseId: row.case_id,
    settlement_tx: row.settlement_tx,
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
   * @throws {DuplicateLedgerEntryError} 同 `(ref, ref_type, category, direction, account)`
   *   已入账 —— 全链路幂等（状态三纪律第 3 条）：重试不重复记账
   */
  public record(entry: LedgerEntry): void {
    const changes = this.db
      .prepare(
        `INSERT OR IGNORE INTO ledger
           (case_id, direction, amount_nominal, amount_actual, ref, ref_type,
            category, account, settlement_tx, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.caseId,
        entry.direction,
        usdc6ToAtomicString(entry.amount_nominal),
        usdc6ToAtomicString(entry.amount_actual),
        entry.ref,
        entry.ref_type,
        entry.category,
        entry.account,
        entry.settlement_tx,
        this.clock().toISOString(),
      );
    if (changes.changes === 0) {
      throw new DuplicateLedgerEntryError(entry.ref, entry.category, entry.account);
    }
  }

  /** 批量入账（任意一条重复即整批回滚）。 */
  public recordAll(entries: readonly LedgerEntry[]): void {
    const tx = this.db.transaction((batch: readonly LedgerEntry[]) => {
      for (const entry of batch) this.record(entry);
    });
    tx(entries);
  }

  /**
   * Gateway 批量结算落链后，给该回执下的所有行补挂结算 tx（v2.3 §3.5）。
   *
   * 幂等：同一回执重复补挂同一个 tx 不报错（结算轮询会重复看到同一笔）；
   * 但**改挂成另一个 tx 会报错**——那意味着我们对同一笔钱有两种说法，必须人来看。
   *
   * @param gatewayReceipt - 回执 ID
   * @param settlementTx - 链上结算交易哈希
   * @returns 补挂的行数
   * @throws {SettlementAttachError} 回执不存在，或已挂了不同的 tx
   */
  public attachSettlementTx(gatewayReceipt: string, settlementTx: string): number {
    const rows = this.db
      .prepare(`SELECT * FROM ledger WHERE ref = ? AND ref_type = 'gateway_receipt'`)
      .all(gatewayReceipt) as LedgerRow[];
    if (rows.length === 0) {
      throw new SettlementAttachError(`no gateway_receipt ledger row for ref: ${gatewayReceipt}`);
    }
    for (const row of rows) {
      if (row.settlement_tx !== null && row.settlement_tx !== settlementTx) {
        throw new SettlementAttachError(
          `receipt ${gatewayReceipt} already settled by a different tx; refusing to overwrite`,
        );
      }
    }
    const changes = this.db
      .prepare(
        `UPDATE ledger SET settlement_tx = ?
         WHERE ref = ? AND ref_type = 'gateway_receipt' AND settlement_tx IS NULL`,
      )
      .run(settlementTx, gatewayReceipt);
    return changes.changes;
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

  /** 尚未补挂结算 tx 的 Gateway 回执行（结算轮询据此工作）。 */
  public pendingSettlements(): readonly LedgerEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ledger
         WHERE ref_type = 'gateway_receipt' AND settlement_tx IS NULL ORDER BY id`,
      )
      .all() as LedgerRow[];
    return rows.map(toEntry);
  }

  /** 按 `amount_actual` 算净额（in 为正、out 为负）。可能为负，故返回裸 `bigint`。 */
  public netActual(caseId?: string): bigint {
    return this.list(caseId).reduce<bigint>(
      (acc, entry) =>
        entry.direction === "in" ? acc + entry.amount_actual : acc - entry.amount_actual,
      0n,
    );
  }

  /** 某案件某类目的实际金额合计（永远非负，故是 {@link Usdc6}）。 */
  public totalActual(category: LedgerCategory, caseId?: string): Usdc6 {
    return this.list(caseId)
      .filter((entry) => entry.category === category)
      .reduce<Usdc6>((acc, entry) => usdc6FromAtomicString((acc + entry.amount_actual).toString()), usdc6FromAtomicString("0"));
  }
}
