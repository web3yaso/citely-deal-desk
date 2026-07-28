/**
 * 检查③：SA 覆盖 rubric 全部判定项，且每腿 condition 合法（合约 §6.3 / v2.2 §3.4）。
 *
 * 纯确定性、纯同步：不联网、不读密钥、不调 LLM。
 */

import { SA_CONDITIONS, SA_CONFIDENCES } from "@citely/engine/sa";
import type { SaCondition, SaConfidence, SettlementAuthorization } from "@citely/engine/sa";
import { outcome } from "./types.js";
import type { CheckFailure, CheckOutcome } from "./types.js";

/**
 * 检查③只需要 rubric 的判定项 id 列表——刻意不依赖 rubric 的完整结构，
 * 避免验证器随 rubric schema 演进而返工（engine 的 rubric 类型是超集）。
 */
export interface RubricRef {
  readonly version: string;
  readonly items: readonly { readonly id: string }[];
}

/** {@link checkRubricCoverage} 的参数。 */
export interface CoverageCheckInput {
  readonly sa: SettlementAuthorization;
  readonly rubric: RubricRef;
}

function isCondition(value: string): value is SaCondition {
  return (SA_CONDITIONS as readonly string[]).includes(value);
}

function isConfidence(value: string): value is SaConfidence {
  return (SA_CONFIDENCES as readonly string[]).includes(value);
}

/**
 * 执行检查③。
 *
 * @param input - SA 与 rubric 的判定项引用
 * @returns 检查结果
 */
export function checkRubricCoverage(input: CoverageCheckInput): CheckOutcome {
  const { sa, rubric } = input;
  const failures: CheckFailure[] = [];

  if (sa.legs.length === 0) {
    failures.push({ code: "no_legs" });
  }

  const covered = new Set<string>();
  for (const [index, leg] of sa.legs.entries()) {
    const at = `legs[${String(index)}]`;
    if (!isCondition(leg.condition)) {
      failures.push({ code: "condition_invalid", detail: `${at}: ${String(leg.condition)}` });
    }
    if (!isConfidence(leg.confidence)) {
      failures.push({ code: "confidence_invalid", detail: `${at}: ${String(leg.confidence)}` });
    }
    if (leg.basis.length === 0) {
      failures.push({ code: "leg_without_basis", detail: at });
    }
    // 出口 4（解释性 gray）必须随附会谈卷宗，否则 ESCALATE 腿无从处置。
    if (leg.condition === "ESCALATE" && leg.escalation === undefined) {
      failures.push({ code: "escalation_material_missing", detail: at });
    }
    for (const basis of leg.basis) covered.add(basis.item_id);
  }

  const rubricIds = new Set(rubric.items.map((item) => item.id));
  const missing = [...rubricIds].filter((id) => !covered.has(id)).sort();
  if (missing.length > 0) {
    failures.push({ code: "rubric_items_uncovered", detail: missing.join(",") });
  }

  const unknown = [...covered].filter((id) => !rubricIds.has(id)).sort();
  if (unknown.length > 0) {
    // 引用了 rubric 里不存在的判定项 = 依据不可复算，同样是不通过。
    failures.push({ code: "unknown_rubric_items", detail: unknown.join(",") });
  }

  if (sa.preview.items_covered !== covered.size) {
    failures.push({
      code: "preview_items_covered_mismatch",
      detail: `preview ${String(sa.preview.items_covered)} != actual ${String(covered.size)}`,
    });
  }

  return outcome("rubric_coverage", failures);
}
