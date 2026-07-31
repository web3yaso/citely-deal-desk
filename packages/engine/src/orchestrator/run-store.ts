/**
 * 请求级幂等的落点（`case_runs` 表）。
 *
 * HTTP 语境下"同一个请求被发两次"是常态：网络抖动、客户端重发、x402 支付凭证重放。
 * 链上写幂等（`tx_log`）与入账幂等（`ledger` 的 UNIQUE）都只在**流程已经开始之后**
 * 起作用，挡不住"第二个请求又从头跑了一遍流程"。本 store 就是那道更外面的闸。
 *
 * 语义（`caseId` 为幂等键）：
 * - 没记录 → 开跑；
 * - 有记录 + **同**请求指纹 + 已成功 → 原样返回上次快照，一步都不重跑；
 * - 有记录 + **不同**请求指纹 → {@link CaseRequestConflictError}，绝不用新参数覆盖旧案件；
 * - 有记录 + 正在跑 → {@link CaseRunInFlightError}（同进程内的并发由 `KeyedMutex` 先挡掉）；
 * - 有记录 + 失败 / 长时间卡在 running（疑似进程崩溃）→ 允许接管重跑。
 *
 * 为什么允许接管：不允许的话，一次进程崩溃会把那个 `caseId` **永久**锁死，
 * 而重跑的安全性本来就有下面三层幂等兜底（tx_log / purchases / ledger）。
 */

import type { EngineDatabase } from "../db/schema.js";
import type { CaseRunSnapshot } from "./types.js";

/** `running` 记录被视为"遗留自崩溃进程"的时限。 */
export const DEFAULT_STALE_RUN_MS = 15 * 60 * 1000;

/** 运行状态。 */
export type CaseRunStatus = "running" | "succeeded" | "failed";

/** `case_runs` 的一行。 */
export interface CaseRunRecord {
  readonly caseId: string;
  readonly requestHash: string;
  readonly status: CaseRunStatus;
  readonly snapshot: CaseRunSnapshot | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** 同一 `caseId` 被换了一份请求参数再发一次。 */
export class CaseRequestConflictError extends Error {
  public readonly caseId: string;

  public constructor(caseId: string) {
    super(
      `case ${caseId} was already run with a different request payload; ` +
        `pick a new caseId instead of overwriting an existing case`,
    );
    this.name = "CaseRequestConflictError";
    this.caseId = caseId;
  }
}

/** 同一 `caseId` 正在别处执行。 */
export class CaseRunInFlightError extends Error {
  public readonly caseId: string;

  public constructor(caseId: string) {
    super(`case ${caseId} is already running; retry after it finishes`);
    this.name = "CaseRunInFlightError";
    this.caseId = caseId;
  }
}

/** 快照存在但读不回来（文件被手改坏，或跨版本格式变了）。 */
export class CaseRunSnapshotError extends Error {
  public constructor(caseId: string, detail: string) {
    super(`case run snapshot for ${caseId} is unusable: ${detail}`);
    this.name = "CaseRunSnapshotError";
  }
}

/** {@link CaseRunStore.begin} 的结论。 */
export type CaseRunAdmission =
  /** 首次运行，往下跑。 */
  | { readonly kind: "started" }
  /** 命中请求级幂等：直接返回上次结果，**不重跑**。 */
  | { readonly kind: "replay"; readonly snapshot: CaseRunSnapshot }
  /** 上次失败或卡死，接管重跑（各步的幂等层负责不重复副作用）。 */
  | { readonly kind: "resumed"; readonly previousError: string | null };

interface CaseRunRow {
  readonly case_id: string;
  readonly request_hash: string;
  readonly status: string;
  readonly snapshot_json: string | null;
  readonly error: string | null;
  readonly started_at: string;
  readonly updated_at: string;
}

/**
 * 反序列化快照。
 *
 * 只做**最小结构校验**再断言类型：快照是本进程自己写进去的，不是外部输入，
 * 为它写一个完整校验器的收益远小于成本；但"文件被手改坏"必须响亮失败，
 * 因为静默当作未命中会让整条流程重跑一遍（重复建 Job 的风险由此而来）。
 */
function parseSnapshot(caseId: string, json: string): CaseRunSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new CaseRunSnapshotError(caseId, `not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new CaseRunSnapshotError(caseId, "not an object");
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec["caseId"] !== "string" || typeof rec["jobId"] !== "string") {
    throw new CaseRunSnapshotError(caseId, "missing caseId/jobId");
  }
  return raw as CaseRunSnapshot;
}

function toRecord(row: CaseRunRow): CaseRunRecord {
  return {
    caseId: row.case_id,
    requestHash: row.request_hash,
    status: row.status as CaseRunStatus,
    snapshot: row.snapshot_json === null ? null : parseSnapshot(row.case_id, row.snapshot_json),
    error: row.error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

/** {@link CaseRunStore} 的构造选项。 */
export interface CaseRunStoreOptions {
  readonly clock?: () => Date;
  /** `running` 记录多久算陈旧（可接管）。 */
  readonly staleRunMs?: number;
}

/** 请求级幂等仓储。 */
export class CaseRunStore {
  private readonly db: EngineDatabase;
  private readonly clock: () => Date;
  private readonly staleRunMs: number;

  public constructor(db: EngineDatabase, options: CaseRunStoreOptions = {}) {
    this.db = db;
    this.clock = options.clock ?? (() => new Date());
    this.staleRunMs = options.staleRunMs ?? DEFAULT_STALE_RUN_MS;
  }

  /**
   * 申请执行一次案件编排。
   *
   * @param caseId - 幂等键
   * @param requestHash - 请求指纹（规范化 JSON 的 sha256）
   * @returns 该往下跑（`started`/`resumed`）还是直接返回旧结果（`replay`）
   * @throws {CaseRequestConflictError} 同 caseId 换了参数
   * @throws {CaseRunInFlightError} 同 caseId 正在别处执行且未陈旧
   */
  public begin(caseId: string, requestHash: string): CaseRunAdmission {
    const now = this.clock().toISOString();
    // INSERT OR IGNORE 而不是"先查后插"：后者在并发/多进程下有 TOCTOU 窗口，
    // 两个请求会一起认定"没记录"然后各建一个 Job。
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO case_runs
           (case_id, request_hash, status, snapshot_json, error, started_at, updated_at)
         VALUES (?, ?, 'running', NULL, NULL, ?, ?)`,
      )
      .run(caseId, requestHash, now, now);
    if (inserted.changes === 1) return { kind: "started" };

    const existing = this.get(caseId);
    if (existing.requestHash !== requestHash) throw new CaseRequestConflictError(caseId);

    if (existing.status === "succeeded") {
      if (existing.snapshot === null) {
        throw new CaseRunSnapshotError(caseId, "run marked succeeded but no snapshot was stored");
      }
      return { kind: "replay", snapshot: existing.snapshot };
    }

    if (existing.status === "running" && !this.isStale(existing)) {
      throw new CaseRunInFlightError(caseId);
    }

    this.markRunning(caseId, now);
    return { kind: "resumed", previousError: existing.error };
  }

  /** 记下成功结果，之后同请求即走重放分支。 */
  public succeed(caseId: string, snapshot: CaseRunSnapshot): void {
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `UPDATE case_runs SET status = 'succeeded', snapshot_json = ?, error = NULL, updated_at = ?
         WHERE case_id = ?`,
      )
      .run(JSON.stringify(snapshot), now, caseId);
  }

  /**
   * 记下失败。**不删记录**：留着才能让下一次请求看到"上次为什么没成"，
   * 也才能保住"同 caseId 不许换参数"这条约束。
   */
  public fail(caseId: string, error: string): void {
    const now = this.clock().toISOString();
    this.db
      .prepare(`UPDATE case_runs SET status = 'failed', error = ?, updated_at = ? WHERE case_id = ?`)
      .run(error, now, caseId);
  }

  /** 查一次运行，不存在返回 `null`（服务的 `GET /cases/:id` 用它）。 */
  public find(caseId: string): CaseRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM case_runs WHERE case_id = ?`).get(caseId) as
      | CaseRunRow
      | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * 查一次运行。
   *
   * @throws {Error} 记录不存在
   */
  public get(caseId: string): CaseRunRecord {
    const record = this.find(caseId);
    if (record === null) throw new Error(`case run not found: ${caseId}`);
    return record;
  }

  private isStale(record: CaseRunRecord): boolean {
    const started = Date.parse(record.startedAt);
    // 时间戳读不出来时按"陈旧"处理：卡死一个 caseId 比多跑一次危险。
    if (Number.isNaN(started)) return true;
    return this.clock().getTime() - started >= this.staleRunMs;
  }

  private markRunning(caseId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE case_runs SET status = 'running', error = NULL, started_at = ?, updated_at = ?
         WHERE case_id = ?`,
      )
      .run(now, now, caseId);
  }
}
