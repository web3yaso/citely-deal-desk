/**
 * 五出口路由（v2.3 §2.2）与出口 3 的采购三约束（§2.1b）。全部是纯函数。
 */

export {
  exitForGrayType,
  itemsNeedingEscalation,
  itemsNeedingProcurement,
  routeExit,
} from "./exits.js";
export type {
  AdjudicationSummary,
  CaseExit,
  ExitActor,
  ExitChainAction,
  ExitDecision,
  IntakeStatus,
  RoutingInput,
} from "./exits.js";

export {
  checkProcurement,
  isProcurementSuccessful,
  PROCUREMENT_MAX_ATTEMPTS,
  shouldRetryProcurement,
} from "./procurement.js";
export type {
  ProcurementDenial,
  ProcurementLimits,
  ProcurementOutcome,
  ProcurementRequest,
  ProcurementVerdict,
} from "./procurement.js";
