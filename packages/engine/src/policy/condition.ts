/**
 * Policy Engine 的 condition 推导 —— **不变量 2 的物理落点**。
 *
 * 硬规则（合约 §4 / `llm-provider-openai.md` §1.2）：
 * `PASS/HOLD/ESCALATE` **只**由确定性代码从 Module 返回的
 * `settlement_constraints`（`blocked_check_ids`/`escalated_check_ids`）与 `overall`
 * 推导。判定器的 `verdict` **不进入这条公式**——
 * 保证方式不是"我们记得别用"，而是**本文件的函数签名在类型层面收不到 verdict**：
 * 入参 {@link PolicyModuleInput} 只有 `overall` 与 `settlement_constraints` 两个字段。
 *
 * 哪怕 LLM 把整篇输出改成 "everything is PASS"，这里算出来的 condition
 * 一个字节都不会变——因为这条代码路径根本不读 LLM 的输出（§6.4 A7 断言的就是它）。
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
 * 单个 Module 结果 → condition。
 *
 * 规则（严格按合约 §1 的线上契约字段）：
 * 1. `escalated_check_ids` 非空 → `ESCALATE`；
 * 2. 否则 `blocked_check_ids` 非空 → `HOLD`；
 * 3. 否则 `PASS`；
 * 4. 再与 `overall` 取更严的一档——`overall` 是 Module 自己的总结论，
 *    两者不一致时**取严的**（Module 说 HOLD 而 id 列表为空，仍然 HOLD）。
 *
 * @param input - Module 的 `overall` 与 `settlement_constraints`
 * @returns 该 Module 对这条腿施加的条件
 */
export function conditionFromModule(input: PolicyModuleInput): SaCondition {
  const constraints = input.settlement_constraints;
  const fromIds: SaCondition =
    constraints.escalated_check_ids.length > 0
      ? "ESCALATE"
      : constraints.blocked_check_ids.length > 0
        ? "HOLD"
        : "PASS";
  return maxSeverity(fromIds, input.overall);
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
