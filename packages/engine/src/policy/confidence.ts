/**
 * 判定器 `verdict` → SA `legs[].confidence` 的映射。
 *
 * **这是 verdict 唯一被允许影响 SA 的地方，而它影响的是"证据成色"，
 * 不是"钱能不能动"**（`llm-provider-openai.md` §1.2 的两套词汇）。
 * condition 由 `condition.ts` 独立算出，本文件的输出不参与那条公式。
 *
 * 合约歧义登记：v2.2 §4.2 只给了 `confidence ∈ {high, gray_data_resolved,
 * gray_interpretive}` 三个取值，没给 5 态 verdict 的映射表（`llm-provider-openai.md`
 * §10 Q1 把映射规则留给 Policy Engine）。本文件按"只许更保守"定表，
 * 其中 `unverifiable` 映射到 `gray_interpretive`——三个取值里没有"看不清"这一档，
 * 而"看不清"必须落到需要人介入的那一档，不能伪装成 `high` 或"买数据可解"。
 */

import type { Verdict } from "../adjudicator/schema.js";
import type { SaConfidence } from "../sa/types.js";

/** 成色由好到差：`high < gray_data_resolved < gray_interpretive`。 */
const SEVERITY: Record<SaConfidence, number> = {
  high: 0,
  gray_data_resolved: 1,
  gray_interpretive: 2,
};

/** 取两个 confidence 中成色更差（更保守）的一个。 */
export function worseConfidence(a: SaConfidence, b: SaConfidence): SaConfidence {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * 单个 verdict → SA confidence。
 *
 * - `confirmed_in_scope` / `confirmed_exempt` → `high`（事实看清楚了）
 * - `gray_data` → `gray_data_resolved`（数据缺口，已由 x402 采购消解，见 v2.2 §2.2 出口 3）
 * - `gray_interpretive` → `gray_interpretive`（法律问题，买数据无用，出口 4）
 * - `unverifiable` → `gray_interpretive`（最保守的可用档，见文件头注释）
 */
export function confidenceFromVerdict(verdict: Verdict): SaConfidence {
  switch (verdict) {
    case "confirmed_in_scope":
    case "confirmed_exempt":
      return "high";
    case "gray_data":
      return "gray_data_resolved";
    case "gray_interpretive":
    case "unverifiable":
      return "gray_interpretive";
  }
}

/**
 * 一条腿的 confidence：取全部依据里成色**最差**的一条。
 *
 * 空依据返回 `gray_interpretive`：没有判定依据的腿不可能是 `high`。
 *
 * @param verdicts - 该腿 `basis[]` 上的全部 verdict
 * @returns 该腿的 confidence
 */
export function deriveLegConfidence(verdicts: readonly Verdict[]): SaConfidence {
  if (verdicts.length === 0) return "gray_interpretive";
  return verdicts.reduce<SaConfidence>(
    (acc, verdict) => worseConfidence(acc, confidenceFromVerdict(verdict)),
    "high",
  );
}
