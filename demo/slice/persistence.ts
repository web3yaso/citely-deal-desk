/**
 * 纵切演示的**本地状态持久化**（状态三纪律第 1 条：SQLite 是唯一真相源）。
 *
 * ## 为什么 dry-run 也必须落盘
 *
 * `--dry-run` 的语义是"**不发链上交易、不付费**"，**不是"不写本地状态"**。
 * 状态机与账本本来就是链下的，dry-run 恰恰应该完整演练它们——否则彩排验的东西
 * 和真跑时不是一套，而彩排的全部意义就是"提前用同一套代码跑一遍"。
 *
 * 2026-07-30 的事故就是这么来的：演示路径完全不碰 SQLite，账本行是内存算出来的，
 * 于是 `DuplicateLedgerEntryError` 这套幂等机制**从未被触发过**，
 * "重跑不重复入账"这条提交物底线一天都没被真正验证。
 *
 * dry-run 用独立库（`deal-desk.dryrun.sqlite`），只是为了不让演练污染真跑的账；
 * 它同样落盘、同样被 `pnpm -F @citely/engine db:reset` 清掉。
 */

import {
  CaseStore,
  DuplicateLedgerEntryError,
  LedgerStore,
  openDatabase,
  resolveDbPath,
  SqliteIdempotencyStore,
  type EngineDatabase,
  type LedgerEntry,
} from "@citely/engine";

/** 一次演示运行的持久化句柄。 */
export interface SlicePersistence {
  /** 库的**绝对路径**（锚在仓库根，与 cwd 无关）。打印它是为了可核对。 */
  readonly dbPath: string;
  readonly db: EngineDatabase;
  readonly cases: CaseStore;
  readonly ledger: LedgerStore;
  /** 注入给 chain 的 `JobClient`——链上写操作先查它，命中即不重发交易。 */
  readonly idempotency: SqliteIdempotencyStore;
  close(): void;
}

/**
 * 打开本次运行的状态库。
 *
 * @param dryRun - dry-run 用独立库
 */
export function openSlicePersistence(dryRun: boolean): SlicePersistence {
  const dbPath = resolveDbPath(process.env, { dryRun });
  const db = openDatabase(dbPath);
  return {
    dbPath,
    db,
    cases: new CaseStore(db),
    ledger: new LedgerStore(db),
    idempotency: new SqliteIdempotencyStore(db),
    close: () => {
      db.close();
    },
  };
}

/** 入账结果：这次真写进去几行、因幂等被挡下几行。 */
export interface LedgerWriteResult {
  readonly inserted: number;
  readonly skipped: number;
}

/**
 * 幂等入账：逐行写，重复的**被挡下并计数**，不让整批失败。
 *
 * 为什么不用 `recordAll`：它是事务性的，任意一行重复就整批回滚——
 * 那对"首次写入"是对的（要么全成要么全不成），但对"重跑"是错的：
 * 重跑时**全部**行都该被挡下，而我们要的是"确认它们被挡下了"，不是抛异常中止演示。
 *
 * @returns 实际写入与被幂等挡下的行数
 */
export function recordLedgerIdempotent(
  ledger: LedgerStore,
  entries: readonly LedgerEntry[],
): LedgerWriteResult {
  let inserted = 0;
  let skipped = 0;
  for (const entry of entries) {
    try {
      ledger.record(entry);
      inserted += 1;
    } catch (err: unknown) {
      // 这正是幂等生效的证据：同一笔收支不会被记第二遍。
      if (!(err instanceof DuplicateLedgerEntryError)) throw err;
      skipped += 1;
    }
  }
  return { inserted, skipped };
}
