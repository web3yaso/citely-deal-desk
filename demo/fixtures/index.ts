/**
 * 演示用合成案件 fixture 的统一出口。
 * engine 的注入回归与 `run-vertical-slice.ts` 都从这里取材料。
 */

export {
  CLEAN_DEAL_INPUT,
  INJECTED_DEAL_INPUT,
  INJECTED_FIELD_PATH,
  INJECTION_PAYLOAD,
} from "./deal-input.js";

export { DEMO_RUBRIC_ID, loadDemoRubric, RUBRICS_DIR } from "./rubric.js";
export type { DemoRubric } from "./rubric.js";

export {
  assertRoyaltyRenderable,
  MODULE_RESPONSE_PROVENANCE,
  loadModuleResponse,
  RECORDED_AT,
  RECORDING_PATH,
  RecordingError,
  SYNTHETIC_MODULE_RESPONSE,
  UnrecordedRoyaltyError,
} from "./module-response.js";
export type { FixtureProvenance, ModuleRecording } from "./module-response.js";
