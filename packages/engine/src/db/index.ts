/**
 * engine 的持久化层：案件状态机（唯一真相源）、幂等表、账本表。
 */

export {
  DEFAULT_DB_PATH,
  findRepoRoot,
  knownDbPaths,
  RepoRootNotFoundError,
  resolveDbPath,
} from "./path.js";
export type { ResolveDbPathOptions } from "./path.js";

export { openDatabase, resetDatabase, SCHEMA_SQL, SCHEMA_VERSION, SchemaVersionError } from "./schema.js";
export type { EngineDatabase } from "./schema.js";

export {
  assertLegalComposite,
  deriveCaseState,
  IllegalCompositeStateError,
  isCompositeTerminal,
} from "./composite.js";
export type { CompositeState } from "./composite.js";

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

export { chainStep, runChainSteps, summarizeRerun } from "./rerun.js";
export type { ChainStepResult, ChainWriter, RerunSummary } from "./rerun.js";

export { DuplicateIdempotencyKeyError, idempotencyKey, SqliteIdempotencyStore } from "./tx-log.js";
export type { ChainAction, IdempotencyRecord, IdempotencyStore } from "./tx-log.js";
