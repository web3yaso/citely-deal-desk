/**
 * `tx_log` 表 —— chain 的 `IdempotencyStore` 的 engine 侧实现（合约 §3）。
 *
 * 依赖方向：chain 定义接口、engine 提供实现、调用方注入。
 * chain 的每个写方法进入即 `lookup`，命中直接返回既有 txHash、**绝不重发交易**
 * （状态三纪律第 3 条：重试不重复付款）。
 *
 * 键**必须**用 chain 导出的 {@link idempotencyKey} 构造，engine 不自己拼字符串——
 * 两边各拼一次就一定会在某个分支上拼歪，而拼歪的后果是重复付款。
 */

import type { ChainAction, IdempotencyRecord, IdempotencyStore } from "@citely/chain/types";
import { idempotencyKey } from "@citely/chain/types";

import type { EngineDatabase } from "./schema.js";

export { idempotencyKey };
export type { ChainAction, IdempotencyRecord, IdempotencyStore };

/** 同一幂等键被重复 `record`。**必须报错而非静默覆盖**（合约 §3）。 */
export class DuplicateIdempotencyKeyError extends Error {
  public readonly key: string;

  public constructor(key: string) {
    super(`idempotency key already recorded: ${key}`);
    this.name = "DuplicateIdempotencyKeyError";
    this.key = key;
  }
}

interface TxLogRow {
  readonly key: string;
  readonly tx_hash: string;
  readonly submitted_at: string;
}

/** SQLite 实现的幂等存储。 */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private readonly db: EngineDatabase;

  public constructor(db: EngineDatabase) {
    this.db = db;
  }

  /**
   * 查既有记录。
   *
   * @param key - 由 {@link idempotencyKey} 构造的键
   * @returns 已执行过则返回记录，否则 `null`
   */
  // 接口是异步的（chain 侧可能换成远程存储），better-sqlite3 是同步的；
  // 标 async 是为了让抛错以 rejection 形式出现，与接口契约一致——
  // 调用方 `await` 时不会被同步 throw 打穿。
  public async lookup(key: string): Promise<IdempotencyRecord | null> {
    const row = this.db.prepare(`SELECT * FROM tx_log WHERE key = ?`).get(key) as
      | TxLogRow
      | undefined;
    if (row === undefined) return null;
    return {
      key: row.key,
      txHash: row.tx_hash as `0x${string}`,
      submittedAt: row.submitted_at,
    };
  }

  /**
   * 写入记录。
   *
   * @throws {DuplicateIdempotencyKeyError} 同 key 已存在
   */
  // 同 lookup：标 async 是为了让抛错以 rejection 形式出现。
  public async record(rec: IdempotencyRecord): Promise<void> {
    // INSERT OR IGNORE + changes 判断，而不是先查后写：后者在并发下有 TOCTOU 窗口。
    const changes = this.db
      .prepare(`INSERT OR IGNORE INTO tx_log (key, tx_hash, submitted_at) VALUES (?, ?, ?)`)
      .run(rec.key, rec.txHash, rec.submittedAt);
    if (changes.changes === 0) throw new DuplicateIdempotencyKeyError(rec.key);
  }

  /** 列出全部记录（按键排序），对账与调试用。 */
  public list(): readonly IdempotencyRecord[] {
    const rows = this.db.prepare(`SELECT * FROM tx_log ORDER BY key`).all() as TxLogRow[];
    return rows.map((row) => ({
      key: row.key,
      txHash: row.tx_hash as `0x${string}`,
      submittedAt: row.submitted_at,
    }));
  }
}
