/**
 * Policy Engine：Module 结果 → SA `legs[].condition`（不变量 2）。
 *
 * 全部是纯函数，不做 IO、不调 LLM、不读环境变量。
 */

export {
  conditionFromModule,
  deriveCondition,
  maxSeverity,
  moduleEvaluatedDeal,
} from "./condition.js";
export type { PolicyModuleInput } from "./condition.js";

export { confidenceFromVerdict, deriveLegConfidence, worseConfidence } from "./confidence.js";

export { buildLeg, buildLegs, buildPreview, countConditions } from "./legs.js";
export type { PolicyBasisInput, PolicyLegInput } from "./legs.js";
