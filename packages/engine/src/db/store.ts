/**
 * 案件状态机的 SQLite 落地（状态三纪律第 1 条的物理落点）。
 *
 * 所有跃迁都先过 `state.ts` 的跃迁表再写库；非法跃迁抛 {@link CaseStateError}，
 * 绝不静默写入——状态机一旦能被写坏，"唯一真相源"就不成立了。
 */

import type { JobState } from "@citely/chain/types";

import type { EngineDatabase } from "./schema.js";
import {
  applyJobState,
  assertCaseTransition,
  assertPartyTaskTransition,
  type CaseExitReason,
  type CaseState,
  type PartyTaskState,
} from "./state.js";

/** 案件行。 */
export interface CaseRow {
  readonly case_id: string;
  readonly state: CaseState;
  readonly exit_reason: CaseExitReason | null;
  readonly job_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 角色任务行。 */
export interface PartyTaskRow {
  readonly case_id: string;
  readonly party: string;
  readonly state: PartyTaskState;
  readonly x402_receipt: string | null;
  readonly verdict: string | null;
  readonly updated_at: string;
}

/** 案件不存在。 */
export class CaseNotFoundError extends Error {
  public constructor(caseId: string) {
    super(`case not found: ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

/** 角色任务不存在。 */
export class PartyTaskNotFoundError extends Error {
  public constructor(caseId: string, party: string) {
    super(`party task not found: ${caseId}/${party}`);
    this.name = "PartyTaskNotFoundError";
  }
}

/** 同一案件重复创建。 */
export class DuplicateCaseError extends Error {
  public constructor(caseId: string) {
    super(`case already exists: ${caseId}`);
    this.name = "DuplicateCaseError";
  }
}

/** 角色任务落地时的附带载荷（合约 §3 的 `awaiting_data(x402_receipt)` / `resolved(verdict)`）。 */
export interface PartyTaskPayload {
  readonly x402Receipt?: string;
  readonly verdict?: string;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

/** 案件状态机仓储。 */
export class CaseStore {
  private readonly db: EngineDatabase;
  private readonly clock: () => Date;

  public constructor(db: EngineDatabase, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * 建案，初始状态 `intake`。
   *
   * @throws {DuplicateCaseError} 同 caseId 已存在
   */
  public createCase(caseId: string): CaseRow {
    if (this.findCase(caseId) !== null) throw new DuplicateCaseError(caseId);
    const ts = nowIso(this.clock);
    this.db
      .prepare(
        `INSERT INTO cases (case_id, state, exit_reason, job_id, created_at, updated_at)
         VALUES (?, 'intake', NULL, NULL, ?, ?)`,
      )
      .run(caseId, ts, ts);
    return this.getCase(caseId);
  }

  /** 查案件，不存在返回 `null`。 */
  public findCase(caseId: string): CaseRow | null {
    const row = this.db.prepare(`SELECT * FROM cases WHERE case_id = ?`).get(caseId);
    return (row as CaseRow | undefined) ?? null;
  }

  /**
   * 查案件。
   *
   * @throws {CaseNotFoundError} 不存在
   */
  public getCase(caseId: string): CaseRow {
    const row = this.findCase(caseId);
    if (row === null) throw new CaseNotFoundError(caseId);
    return row;
  }

  /** 绑定 8183 jobId（createJob 成功后调用）。 */
  public setJobId(caseId: string, jobId: bigint | string): CaseRow {
    this.getCase(caseId);
    this.db
      .prepare(`UPDATE cases SET job_id = ?, updated_at = ? WHERE case_id = ?`)
      .run(typeof jobId === "bigint" ? jobId.toString() : jobId, nowIso(this.clock), caseId);
    return this.getCase(caseId);
  }

  /**
   * 推进案件状态。
   *
   * @param exitReason - 终局态必须给出出口（v2.2 §2.2 五出口），非终局态必须为空
   * @throws {CaseStateError} 跃迁非法
   */
  public transitionCase(caseId: string, to: CaseState, exitReason?: CaseExitReason): CaseRow {
    const current = this.getCase(caseId);
    assertCaseTransition(current.state, to);
    this.db
      .prepare(`UPDATE cases SET state = ?, exit_reason = ?, updated_at = ? WHERE case_id = ?`)
      .run(to, exitReason ?? current.exit_reason, nowIso(this.clock), caseId);
    return this.getCase(caseId);
  }

  /**
   * 用链上状态对账（链上事件**只**用于对账，不重建状态）。
   *
   * 链上未终局时不动本地状态；终局时按 {@link applyJobState} 的映射推进，
   * 其中 `expired` 走独立的 `timeout_refund` 出口，不与验证器拒绝混淆。
   *
   * @returns 对账后的案件行；链上未终局时原样返回
   */
  public reconcileJobState(caseId: string, jobState: JobState): CaseRow {
    const current = this.getCase(caseId);
    const mapping = applyJobState(jobState, current.state === "submitted");
    if (mapping.caseState === null) return current;
    if (current.state === mapping.caseState) return current;
    return this.transitionCase(caseId, mapping.caseState, mapping.exitReason ?? undefined);
  }

  /** 建角色任务，初始状态 `pending`（同 party 重复建视为幂等，返回既有行）。 */
  public createPartyTask(caseId: string, party: string): PartyTaskRow {
    this.getCase(caseId);
    const existing = this.findPartyTask(caseId, party);
    if (existing !== null) return existing;
    this.db
      .prepare(
        `INSERT INTO party_tasks (case_id, party, state, x402_receipt, verdict, updated_at)
         VALUES (?, ?, 'pending', NULL, NULL, ?)`,
      )
      .run(caseId, party, nowIso(this.clock));
    return this.getPartyTask(caseId, party);
  }

  /** 查角色任务，不存在返回 `null`。 */
  public findPartyTask(caseId: string, party: string): PartyTaskRow | null {
    const row = this.db
      .prepare(`SELECT * FROM party_tasks WHERE case_id = ? AND party = ?`)
      .get(caseId, party);
    return (row as PartyTaskRow | undefined) ?? null;
  }

  /**
   * 查角色任务。
   *
   * @throws {PartyTaskNotFoundError} 不存在
   */
  public getPartyTask(caseId: string, party: string): PartyTaskRow {
    const row = this.findPartyTask(caseId, party);
    if (row === null) throw new PartyTaskNotFoundError(caseId, party);
    return row;
  }

  /**
   * 推进角色任务状态。
   *
   * @param payload - `awaiting_data` 带 x402 回执、`resolved` 带 verdict
   * @throws {CaseStateError} 跃迁非法
   */
  public transitionPartyTask(
    caseId: string,
    party: string,
    to: PartyTaskState,
    payload: PartyTaskPayload = {},
  ): PartyTaskRow {
    const current = this.getPartyTask(caseId, party);
    assertPartyTaskTransition(current.state, to);
    this.db
      .prepare(
        `UPDATE party_tasks SET state = ?, x402_receipt = ?, verdict = ?, updated_at = ?
         WHERE case_id = ? AND party = ?`,
      )
      .run(
        to,
        payload.x402Receipt ?? current.x402_receipt,
        payload.verdict ?? current.verdict,
        nowIso(this.clock),
        caseId,
        party,
      );
    return this.getPartyTask(caseId, party);
  }

  /** 列出案件的全部角色任务（按 party 排序，便于确定性断言）。 */
  public listPartyTasks(caseId: string): readonly PartyTaskRow[] {
    return this.db
      .prepare(`SELECT * FROM party_tasks WHERE case_id = ? ORDER BY party`)
      .all(caseId) as PartyTaskRow[];
  }
}
