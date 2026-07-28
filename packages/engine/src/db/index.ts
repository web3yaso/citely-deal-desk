/**
 * engine 的持久化层：案件状态机（唯一真相源）、幂等表、账本表。
 */

export { openDatabase, SCHEMA_SQL } from "./schema.js";
export type { EngineDatabase } from "./schema.js";

export {
  applyJobState,
  assertCaseTransition,
  assertPartyTaskTransition,
  CaseStateError,
  isTerminalCaseState,
} from "./state.js";
export type { CaseExitReason, CaseState, JobStateMapping, PartyTaskState } from "./state.js";

export {
  CaseNotFoundError,
  CaseStore,
  DuplicateCaseError,
  PartyTaskNotFoundError,
} from "./store.js";
export type { CaseRow, PartyTaskPayload, PartyTaskRow } from "./store.js";

export { DuplicateIdempotencyKeyError, idempotencyKey, SqliteIdempotencyStore } from "./tx-log.js";
export type { ChainAction, IdempotencyRecord, IdempotencyStore } from "./tx-log.js";
