/**
 * 编排层的唯一对外入口（`import "@citely/engine/orchestrator"`）。
 *
 * 服务外壳（HTTP）与演示脚本都只该用到这里导出的东西：一个 {@link runCase}
 * 加上它需要的仓储与类型。**编排主线只有一条**，两边的差别全在注入的实现里。
 *
 * 它刻意不进 `@citely/engine` 的总 barrel：`runCase` 会把判定器（连带 `openai`
 * SDK）拉进任何 import 它的进程，而验证器进程按密钥纪律不该持有 `OPENAI_API_KEY`。
 */

export {
  EscalationConfigMissingError,
  ExternalJobError,
  IntakeRejectedError,
  requestFingerprint,
  runCase,
} from "./run-case.js";
export type { ExternalJobRejection } from "./run-case.js";

export { KeyedMutex } from "./keyed-mutex.js";

export {
  CaseRequestConflictError,
  CaseRunInFlightError,
  CaseRunSnapshotError,
  CaseRunStore,
  DEFAULT_STALE_RUN_MS,
} from "./run-store.js";
export type { CaseRunAdmission, CaseRunRecord, CaseRunStatus, CaseRunStoreOptions } from "./run-store.js";

export { procureOnce, ProcurementFailedError, PurchaseRecordError, PurchaseStore } from "./purchase-store.js";
export type { ProcureOnceParams, ProcurementResult, PurchaseRecord } from "./purchase-store.js";

export {
  advanceCaseState,
  assembleSa,
  buildCaseEscalation,
  buildSettlementLegs,
  completeLedger,
  deriveIntakeStatus,
  intake,
  procurementLedger,
  recordLedgerIdempotent,
  toRoutingSummaries,
} from "./stages.js";
export type {
  AssembleSaParams,
  BuildCaseEscalationParams,
  BuildLegsParams,
  CompleteLedgerParams,
  LedgerWriteResult,
  ProcurementLedgerParams,
} from "./stages.js";

export type {
  CaseRequest,
  CaseResult,
  CaseRunSnapshot,
  CaseStores,
  CheckOutcomeView,
  EscalationConfig,
  JobRequest,
  ProcurementReceipt,
  RoutingView,
  RunCaseDeps,
  SettlementActionView,
  SettlementRequest,
  SettleRequest,
  SettlePort,
  VerificationReportView,
  VerifyPort,
  VerifyRequest,
} from "./types.js";
