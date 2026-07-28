/**
 * 收口动作：三检结论 → 链上 `complete` / `reject`（合约 §6 / v2.2 §2.2 出口 1、2）。
 *
 * 状态与授权矩阵照录合约 §2.3（参考实现原文，不是我们的发明）：
 *
 * | 函数 | 允许入口状态 | 谁能调 | 出口状态 |
 * |---|---|---|---|
 * | `complete` | 仅 Submitted | 仅 evaluator | Completed |
 * | `reject` | Open | 仅 client | Rejected |
 * | `reject` | Funded 或 Submitted | 仅 evaluator | Rejected |
 * | `claimRefund` | Funded/Submitted 且已过期 | **permissionless** | Expired |
 *
 * 本模块是 **evaluator（验证器密钥）** 侧，因此：
 * - `complete` 只在 Submitted 态；
 * - `reject` 在 **Funded 与 Submitted 两态**都要能行使——Submitted 是常规路径，
 *   Funded 是 v2.2 §2.2 出口 1 的"提交前拒绝"早退路径；
 * - Open 态的 reject 是 **client** 的权限，不是我们的，遇到即抛错中止。
 *
 * ⚠️ `claimRefund` 在参考实现里**没有 `msg.sender` 检查（permissionless）**，
 * 任何人都能替 client 触发退款。我方仍由 client 角色调用，但**不许**据此
 * 做"只有 client 能退款"的安全推断（例如拿它当身份证明）。
 *
 * 其余纪律：
 * - 上链的只有 `reasonHash`（不变量 4），理由明文留在链下卷宗；
 * - 状态不对**抛错中止**，绝不"试一下看链上收不收"（失败的交易也要花钱，
 *   且掩盖了真正的编排 bug）；
 * - 交易由 chain 的 `JobClient` 发出，用**验证器密钥**的 client；
 *   幂等由 `JobClient` 内部的 `IdempotencyStore` 承担，本模块不重复实现。
 */

import type { JobClient, JobState } from "@citely/chain";
import type { Hex } from "viem";

import type { VerificationReport } from "./verify.js";

/** 收口失败：Job 状态与结论不匹配。 */
export class SettlementStateError extends Error {
  public readonly jobId: bigint;
  public readonly state: JobState;

  public constructor(message: string, jobId: bigint, state: JobState) {
    super(message);
    this.name = "SettlementStateError";
    this.jobId = jobId;
    this.state = state;
  }
}

/** `complete` 的唯一合法入口状态（合约 §2.3）。 */
export const COMPLETE_ALLOWED_STATES: readonly JobState[] = ["submitted"];

/** evaluator 行使 `reject` 的合法入口状态（合约 §2.3；Open 态归 client）。 */
export const EVALUATOR_REJECT_ALLOWED_STATES: readonly JobState[] = ["funded", "submitted"];

/** 收口结果。 */
export interface SettlementAction {
  readonly action: "complete" | "reject";
  readonly jobId: bigint;
  readonly reasonHash: Hex;
  readonly txHash: Hex;
}

/** {@link settleVerifiedJob} 的参数。 */
export interface SettleParams {
  readonly jobClient: JobClient;
  readonly jobId: bigint;
  readonly report: VerificationReport;
}

/**
 * 按三检结论执行收口。
 *
 * @param params - JobClient、jobId 与三检结论
 * @returns 实际执行的链上动作与 txHash
 * @throws {SettlementStateError} 状态不在合约 §2.3 允许的入口态内
 */
export async function settleVerifiedJob(params: SettleParams): Promise<SettlementAction> {
  const { jobClient, jobId, report } = params;
  const state = await jobClient.getJobState(jobId);

  if (report.passed) {
    requireState(jobId, state, COMPLETE_ALLOWED_STATES, "complete");
    const txHash = await jobClient.complete(jobId, report.reasonHash);
    return { action: "complete", jobId, reasonHash: report.reasonHash, txHash };
  }

  // 出口 1：受理失败在 Funded / Submitted 两态行使拒绝权（合约 §2.3）。
  requireState(jobId, state, EVALUATOR_REJECT_ALLOWED_STATES, "reject");
  const txHash = await jobClient.reject(jobId, report.reasonHash);
  return { action: "reject", jobId, reasonHash: report.reasonHash, txHash };
}

/**
 * 断言 Job 处于某动作允许的入口状态。
 *
 * @param jobId - 8183 jobId
 * @param state - 链上读回的当前状态
 * @param allowed - 该动作允许的入口状态集合
 * @param action - 动作名，仅用于错误消息
 * @throws {SettlementStateError} 状态不在允许集合内
 */
function requireState(
  jobId: bigint,
  state: JobState,
  allowed: readonly JobState[],
  action: "complete" | "reject",
): void {
  if (allowed.includes(state)) return;
  throw new SettlementStateError(
    `${action} requires job in ${allowed.map((s) => `"${s}"`).join(" or ")} state, got "${state}"`,
    jobId,
    state,
  );
}
