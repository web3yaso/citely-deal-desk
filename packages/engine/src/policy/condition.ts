/**
 * Policy Engine 的 condition 推导 —— **不变量 2 的物理落点**。
 *
 * 硬规则（合约 §4 / `llm-provider-openai.md` §1.2）：
 * `PASS/HOLD/ESCALATE` **只**由确定性代码从 Module 返回的
 * `settlement_constraints`（`blocked_check_ids`/`escalated_check_ids`/
 * `evaluated_check_count`）与 `overall` 推导。判定器的 `verdict` **不进入这条公式**——
 * 保证方式不是"我们记得别用"，而是**本文件的函数签名在类型层面收不到 verdict**：
 * 入参 {@link PolicyModuleInput} 只有 `overall` 与 `settlement_constraints` 两个字段。
 *
 * 哪怕 LLM 把整篇输出改成 "everything is PASS"，这里算出来的 condition
 * 一个字节都不会变——因为这条代码路径根本不读 LLM 的输出（§6.4 A7 断言的就是它）。
 *
 * **2026-07-31 上游破坏性变更**（`docs/design/upstream-msb-api-breaking-change-2026-07-31.md`）：
 * `activity` 是调用方完全可控的请求字段，把真实的 money_transmission 填成
 * `check_cashing` 去调某法域模块，法域守卫不拦，结果是全部规则不匹配 →
 * `overall = NOT_APPLICABLE`、两个阻断列表都为空、外加一个可离线复算通过的
 * `evidence_hash`。所以"两个列表都空"**不再是**放行依据：还必须
 * `evaluated_check_count > 0`（本模块真的评估过这笔交易）。
 */

import type { CheckStatus, SettlementConstraints } from "@citely/chain/types";

import type { SaCondition } from "../sa/types.js";

/**
 * 严重度序：`PASS < HOLD < ESCALATE`。
 * 合并多个来源时**只允许取更严的一档**（单调收紧），没有任何放宽路径。
 */
const SEVERITY: Record<SaCondition, number> = { PASS: 0, HOLD: 1, ESCALATE: 2 };

/** 取两个 condition 中更严的一个。 */
export function maxSeverity(a: SaCondition, b: SaCondition): SaCondition {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * condition 推导的**唯一**输入形状。
 *
 * 刻意窄到只剩两个字段：`ModuleResponse` 的其余部分（尤其任何判定器产物）
 * 在类型上就传不进来。
 */
export interface PolicyModuleInput {
  readonly overall: CheckStatus;
  readonly settlement_constraints: SettlementConstraints;
}

/**
 * 本模块**是否真的评估过这笔交易**。
 *
 * `evaluated_check_count === 0` 表示该模块规则集对这笔交易没有可适用的检查项——
 * 此时两个阻断列表天然为空，那是"没查"，不是"查过没问题"。
 *
 * @param constraints - Module 返回的 `settlement_constraints`
 * @returns 评估过（才允许进入放行分支）为 `true`
 */
export function moduleEvaluatedDeal(
  constraints: Pick<SettlementConstraints, "evaluated_check_count">,
): boolean {
  return constraints.evaluated_check_count > 0;
}

/**
 * `overall` 的下限贡献。
 *
 * `NOT_APPLICABLE` **不是** `PASS` 的同义词，更不是放行信号：整体不适用意味着
 * 本模块没有对这笔交易做出任何判断，只能转人工（`ESCALATE`），
 * 绝不允许有任何一条路径把它折叠成 `PASS`。
 */
function conditionFromOverall(overall: CheckStatus): SaCondition {
  return overall === "NOT_APPLICABLE" ? "ESCALATE" : overall;
}

/**
 * `settlement_constraints` 的下限贡献（放行判据本体）。
 *
 * 两个阻断列表都为空是**唯一**可能放行的分支，也正是上游漏洞的落点：
 * 必须再有"本模块确实评估过这笔交易"的证据才允许 `PASS`。
 */
function conditionFromConstraints(constraints: SettlementConstraints): SaCondition {
  if (constraints.escalated_check_ids.length > 0) return "ESCALATE";
  if (constraints.blocked_check_ids.length > 0) return "HOLD";
  return moduleEvaluatedDeal(constraints) ? "PASS" : "ESCALATE";
}

/**
 * 单个 Module 结果 → condition。
 *
 * 规则（严格按合约 §1 的线上契约字段）：
 * 1. `escalated_check_ids` 非空 → `ESCALATE`；
 * 2. 否则 `blocked_check_ids` 非空 → `HOLD`；
 * 3. 否则**两个列表都空**：只有本模块确实评估过这笔交易
 *    （`evaluated_check_count > 0`）才是 `PASS`；没评估过 → `ESCALATE`
 *    （该换法域模块或转人工，不是放行）；
 * 4. 再与 `overall` 取更严的一档——`overall` 是 Module 自己的总结论，
 *    两者不一致时**取严的**（Module 说 HOLD 而 id 列表为空，仍然 HOLD；
 *    `overall = NOT_APPLICABLE` 则为 `ESCALATE`）。
 *
 * @param input - Module 的 `overall` 与 `settlement_constraints`
 * @returns 该 Module 对这条腿施加的条件
 */
export function conditionFromModule(input: PolicyModuleInput): SaCondition {
  return maxSeverity(
    conditionFromConstraints(input.settlement_constraints),
    conditionFromOverall(input.overall),
  );
}

/**
 * 一条腿引用多个 Module 时的合并：取**最严**的一档。
 *
 * 空输入返回 `ESCALATE`：没有任何 Module 依据就没有放行的理由，
 * 而"无依据"需要人来看，不是"等数据"，所以取最严档而不是 `HOLD`。
 *
 * @param inputs - 该腿引用的全部 Module 结果
 * @returns 合并后的 condition
 */
export function deriveCondition(inputs: readonly PolicyModuleInput[]): SaCondition {
  if (inputs.length === 0) return "ESCALATE";
  return inputs.reduce<SaCondition>(
    (acc, input) => maxSeverity(acc, conditionFromModule(input)),
    "PASS",
  );
}
