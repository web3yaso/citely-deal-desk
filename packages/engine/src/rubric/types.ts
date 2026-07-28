/**
 * rubric schema —— **逐字照录 v2.2 §4.1**，不增删字段。
 *
 * rubric 是 L1 知识层的产物，在本仓库里只被读取，不被引擎改写。
 * 它是判定器 system prompt 的**唯一**内容来源（不变量 5：材料不进指令通道）。
 */

/** v2.2 §4.1 `verdict_states` 的取值。注意它只有 3 个，引擎 verdict 是 5 态。 */
export type RubricVerdictState = "confirmed_in_scope" | "confirmed_exempt" | "gray_interpretive";

export interface RubricAuthor {
  readonly name: string;
  readonly license: string;
  readonly wallet: string;
}

export interface RubricItem {
  readonly id: string;
  readonly question: string;
  readonly signals: readonly string[];
  readonly acceptance_criteria: readonly string[];
  readonly common_rejection_reasons: readonly string[];
  /** 法源标识，多条时以 ` / ` 分隔。它是 `source_refs` 白名单的来源。 */
  readonly source: string;
  readonly confidence_rule: string;
}

export interface Rubric {
  readonly scenario: string;
  readonly version: string;
  readonly last_verified_date: string;
  readonly author: RubricAuthor;
  readonly royalty_bps: number;
  readonly items: readonly RubricItem[];
  readonly verdict_states: readonly RubricVerdictState[];
}

/** 已加载的 rubric。`id` 不在 v2.2 schema 里，由文件名派生，用于 cache key。 */
export interface LoadedRubric {
  readonly id: string;
  readonly rubric: Rubric;
}
