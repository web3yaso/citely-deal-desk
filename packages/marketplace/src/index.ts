/**
 * `@citely/marketplace` —— L4 客户执行层演示 agent。
 *
 * 立场声明：本包扮演**客户侧**。它消费 Citely 出具的 SA（条件证明），
 * 按**自有预设策略**核验后自行决定是否执行付款。Citely 不授权任何付款。
 */

export {
  buildCaseDescription,
  CASE_DESCRIPTION_PREFIX,
  MarketplaceAgent,
  MarketplaceAgentError,
} from "./agent.js";
export type {
  MarketplaceAgentDeps,
  OpenCaseParams,
  PaymentExecutor,
  SettlementRun,
} from "./agent.js";

export {
  FORBIDDEN_ENV_VARS,
  MARKETPLACE_PRIVATE_KEY_VAR,
  MarketplaceKeyError,
  readMarketplaceKey,
} from "./key-source.js";
export type { EnvSource, MarketplaceKeyMaterial } from "./key-source.js";

export { applySettlementPolicy } from "./policy.js";
export type {
  PlannedPayment,
  PolicyBlocker,
  PolicyInput,
  SettlementDecision,
  WalletSettlementPolicy,
  WithheldLeg,
} from "./policy.js";

export { observeSa, SaShapeError } from "./sa-view.js";
export type { ObservedCondition, ObservedLeg, ObservedSa } from "./sa-view.js";
