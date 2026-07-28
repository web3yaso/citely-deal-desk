/**
 * 三检的共用结果形状（合约 §6）。
 *
 * 检查函数**不抛错表达"不通过"**：不通过是正常业务结果（出口 1 要据此 reject），
 * 抛错只留给"输入根本没法检查"（如 SA 结构损坏）。
 */

/** 三检标识。进 reasonHash，逐字节稳定。 */
export type CheckId = "deliverable_signature" | "module_attestation" | "rubric_coverage";

/**
 * 一条不通过原因。
 * `code` 是稳定枚举（进 reasonHash），`detail` 只给日志与人看，**不进哈希**。
 */
export interface CheckFailure {
  readonly code: string;
  readonly detail?: string;
}

export interface CheckOutcome {
  readonly check: CheckId;
  readonly passed: boolean;
  readonly failures: readonly CheckFailure[];
}

/**
 * 由失败列表构造结果（空列表即通过）。
 *
 * @param check - 检查标识
 * @param failures - 不通过原因列表
 * @returns 检查结果
 */
export function outcome(check: CheckId, failures: readonly CheckFailure[]): CheckOutcome {
  return { check, passed: failures.length === 0, failures };
}
