/**
 * 把"腿的商务信息 + Module 结果 + 判定证据"组装成 SA 的 `legs[]`。
 *
 * 组装顺序刻意分成两次独立计算，且**互不传参**：
 * - `condition` ← `deriveCondition(input.modules)`（只看 Module）
 * - `confidence` ← `deriveLegConfidence(basis 的 verdict)`（只看判定器）
 *
 * 这样"verdict 影响了 condition"这件事在本文件里没有可写出来的形式。
 */

import type { Address } from "viem";

import type { Verdict } from "../adjudicator/schema.js";
import type { SaBasis, SaCondition, SaEscalation, SaLeg, SaPreview } from "../sa/types.js";
import { usdc6ToAtomicString } from "../util/usdc6.js";
import type { Usdc6 } from "../util/usdc6.js";
import { deriveCondition, type PolicyModuleInput } from "./condition.js";
import { deriveLegConfidence } from "./confidence.js";

/** 一条判定依据的输入。`verdict` 只流向 `basis[]` 与 `confidence`。 */
export interface PolicyBasisInput {
  readonly item_id: string;
  readonly verdict: Verdict;
  /** rubric item 的法源标识，原样落进 SA 的 `basis[].source`。 */
  readonly source: string;
}

/** 一条腿的完整输入。 */
export interface PolicyLegInput {
  readonly party: string;
  /** 收款方地址。客户资金永不经过 Citely（不变量 3）。 */
  readonly payee: Address;
  /**
   * 名义金额，**最小单位**（v2.3 §9）。
   * 进 SA 时才转成十进制字符串（JSON 没有 bigint）——那是序列化，不是"用小数算钱"。
   */
  readonly amount_nominal: Usdc6;
  /** 该腿引用的 Module 结果——**condition 的唯一输入**。 */
  readonly modules: readonly PolicyModuleInput[];
  /** 判定器证据——只进 `basis[]` 与 `confidence`。 */
  readonly basis: readonly PolicyBasisInput[];
  /** 解释性 gray 的升级材料（出口 4）。 */
  readonly escalation?: SaEscalation;
}

function toSaBasis(input: PolicyBasisInput): SaBasis {
  return { item_id: input.item_id, verdict: input.verdict, source: input.source };
}

/**
 * 组装一条 SA leg。
 *
 * @param input - 腿的商务信息、Module 结果与判定证据
 * @returns SA `legs[]` 的一个元素
 */
export function buildLeg(input: PolicyLegInput): SaLeg {
  const condition = deriveCondition(input.modules);
  const confidence = deriveLegConfidence(input.basis.map((b) => b.verdict));
  const base = {
    party: input.party,
    payee: input.payee,
    // 唯一的序列化点：bigint 进不了 JSON，落 SA 用最小单位十进制字符串。
    amount_nominal: usdc6ToAtomicString(input.amount_nominal),
    condition,
    basis: input.basis.map(toSaBasis),
    confidence,
  };
  // exactOptionalPropertyTypes 下不能写 `escalation: undefined`，只能条件展开。
  return input.escalation === undefined ? base : { ...base, escalation: input.escalation };
}

/** 批量组装，顺序原样保留（顺序是语义的一部分，会进 SA 哈希）。 */
export function buildLegs(inputs: readonly PolicyLegInput[]): readonly SaLeg[] {
  return inputs.map(buildLeg);
}

/** 按 `PASS/HOLD/ESCALATE` 统计腿数。 */
export function countConditions(
  legs: readonly { readonly condition: SaCondition }[],
): Record<SaCondition, number> {
  const counts: Record<SaCondition, number> = { PASS: 0, HOLD: 0, ESCALATE: 0 };
  for (const leg of legs) counts[leg.condition] += 1;
  return counts;
}

/**
 * 生成 v2.2 §4.2 `preview.condition_summary` 的措辞：`"3 PASS / 1 HOLD / 1 ESCALATE"`。
 *
 * @param legs - 已算出 condition 的腿
 * @param itemsCovered - 本 SA 覆盖的 rubric 判定项数
 */
export function buildPreview(
  legs: readonly { readonly condition: SaCondition }[],
  itemsCovered: number,
): SaPreview {
  const counts = countConditions(legs);
  return {
    condition_summary: `${String(counts.PASS)} PASS / ${String(counts.HOLD)} HOLD / ${String(counts.ESCALATE)} ESCALATE`,
    items_covered: itemsCovered,
  };
}
