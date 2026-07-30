/**
 * 整份 rubric 的判定编排（案件引擎职责，故归 engine 而不是演示脚本）。
 *
 * `adjudicateItem()` 一次判一条；本文件把"判完一份 rubric 的全部判定项"这件事
 * 收成一个函数，让调用方（演示脚本 / 将来的案件引擎）只需一行。
 *
 * **不变量 2**：本文件产出的 `verdict` 只经 {@link toItemVerdicts} 流向
 * SA 的 `basis[]` 与 `confidence`。`condition` 由 `policy/condition.ts` 从
 * Module 结果推导，那条函数的入参类型里没有 verdict 的位置——
 * 也就是说，**接判定器在类型层面就不可能让 LLM 参与放款决策**。
 */

import type { LoadedRubric } from "../rubric/types.js";
import type { SanitizedFacts } from "../sandbox/types.js";
import { adjudicateItem } from "./index.js";
import type { AdjudicatorDeps } from "./index.js";
import type { Confidence, GrayType, Verdict } from "./schema.js";

/** 一条判定项的结果 + 溯源，供 `basis[]` 与演示输出使用。 */
export interface AdjudicatedItem {
  readonly item_id: string;
  readonly verdict: Verdict;
  readonly gray_type: GrayType | undefined;
  readonly confidence: Confidence;
  readonly risk_flags: readonly string[];
  /** rubric 的法源标识，原样进 `basis[].source`。 */
  readonly source: string;
  /** `true` = 来自 golden cache（离线可复现）；`false` = 本次真调了 API。 */
  readonly cacheHit: boolean;
  /** 后置校验做过的确定性修正（§4.4）；`fallback:*` 表示走了 §4.5 兜底。 */
  readonly repairs: readonly string[];
}

/** {@link adjudicateRubric} 的参数。 */
export interface AdjudicateRubricParams {
  /** 只用于日志，**不进 cache key**（§4.3）。 */
  readonly caseId: string;
  readonly rubric: LoadedRubric;
  /** 沙箱输出——材料能到达判定器的唯一形态（不变量 5）。 */
  readonly facts: SanitizedFacts;
  readonly deps: AdjudicatorDeps;
}

/**
 * 逐条判定 rubric 的全部判定项。
 *
 * **串行而不是并发**：判定项之间没有依赖，但串行让结果顺序确定，
 * 而 `basis[]` 的顺序进 `deliverableHash`——`sa_hash` 的稳定性依赖它。
 * 并发只能省几秒，代价是引入一个不确定性来源，不划算。
 *
 * 单项失败不会中断整份 rubric：`adjudicateItem` 内部按 §4.5 兜底为
 * `unverifiable` + 原因 flag（`cache_only` 未命中除外，那个必须响亮失败）。
 *
 * @param params - 案件、rubric、沙箱输出、判定器依赖
 * @returns 按 `rubric.items` 顺序排列的判定结果
 * @throws {GoldenCacheMissError} `cache_only` 模式未命中
 */
export async function adjudicateRubric(
  params: AdjudicateRubricParams,
): Promise<readonly AdjudicatedItem[]> {
  const out: AdjudicatedItem[] = [];
  for (const item of params.rubric.rubric.items) {
    const envelope = await adjudicateItem(
      {
        caseId: params.caseId,
        rubric: {
          id: params.rubric.id,
          version: params.rubric.rubric.version,
          verdict_states: params.rubric.rubric.verdict_states,
        },
        item,
        facts: params.facts,
      },
      params.deps,
    );
    out.push({
      item_id: envelope.result.item_id,
      verdict: envelope.result.verdict,
      gray_type: envelope.result.gray_type,
      confidence: envelope.result.confidence,
      risk_flags: envelope.result.risk_flags,
      source: item.source,
      cacheHit: envelope.provenance.cacheHit,
      repairs: envelope.provenance.repairs,
    });
  }
  return out;
}

/** 每个 rubric item 的 verdict 映射——SA 组装时喂给 `basis[]`。 */
export type ItemVerdicts = Readonly<Record<string, Verdict>>;

/**
 * 判定结果 → verdict 映射。
 *
 * 这是 verdict 离开判定器后的**唯一**去向。它不碰 condition，
 * 也没有任何 API 让它碰得到。
 */
export function toItemVerdicts(items: readonly AdjudicatedItem[]): ItemVerdicts {
  return Object.fromEntries(items.map((i) => [i.item_id, i.verdict]));
}

/** 判定结果的汇总视图，给演示输出与卷宗用。 */
export interface AdjudicationSummaryView {
  readonly total: number;
  /** 命中 golden 的条数——`total` 时即"离线可复现"。 */
  readonly cacheHits: number;
  /** verdict → 条数。 */
  readonly distribution: Readonly<Record<string, number>>;
  /** 全部风险标记的并集（已排序去重）。 */
  readonly riskFlags: readonly string[];
  /** 走了 §4.5 兜底的判定项 id——**降级必须可见**。 */
  readonly fallbacks: readonly string[];
}

/** 汇总判定结果。纯函数，便于演示脚本直接打印。 */
export function summarizeAdjudication(
  items: readonly AdjudicatedItem[],
): AdjudicationSummaryView {
  const distribution: Record<string, number> = {};
  for (const i of items) distribution[i.verdict] = (distribution[i.verdict] ?? 0) + 1;
  return {
    total: items.length,
    cacheHits: items.filter((i) => i.cacheHit).length,
    distribution,
    riskFlags: [...new Set(items.flatMap((i) => i.risk_flags))].sort(),
    fallbacks: items.filter((i) => i.repairs.some((r) => r.startsWith("fallback:"))).map((i) => i.item_id),
  };
}
