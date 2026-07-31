/**
 * 历史入口，现在**只是转发**。
 *
 * 这些阶段函数原本在演示里各写一份，与 `@citely/engine/orchestrator` 那份并存。
 * 并存的代价是"改一处不改另一处"——演示对而服务错，且两边的 bug 互不暴露。
 * 演示切到 `runCase()` 之后，实现**只剩 engine 一份**，本文件仅保留
 * `@citely/demo/slice/stages` 这个导入路径，供 engine 的两个脚本
 * （`scripts/golden.ts`、`scripts/injection-live-check.ts`）继续用。
 *
 * 不要在这里加新逻辑。要改阶段行为，改 `packages/engine/src/orchestrator/stages.ts`。
 */

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
} from "@citely/engine/orchestrator";

export type {
  AssembleSaParams,
  BuildCaseEscalationParams,
  BuildLegsParams,
  CompleteLedgerParams,
  LedgerWriteResult,
  ProcurementLedgerParams,
} from "@citely/engine/orchestrator";
