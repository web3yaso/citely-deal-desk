/**
 * 收口动作：三检结论 → 链上 `complete` / `reject`（合约 §6 / v2.2 §2.2 出口 1、2）。
 *
 * 纪律：
 * - 上链的只有 `reasonHash`（不变量 4），理由明文留在链下卷宗；
 * - `complete` 只在 Submitted 态、`reject` 只在 Funded 态——状态不对**抛错中止**，
 *   绝不"试一下看链上收不收"（失败的交易也要花钱，且掩盖了真正的编排 bug）；
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
 * @throws {SettlementStateError} 通过但不在 Submitted 态，或不通过但不在 Funded 态
 */
export async function settleVerifiedJob(params: SettleParams): Promise<SettlementAction> {
  const { jobClient, jobId, report } = params;
  const state = await jobClient.getJobState(jobId);

  if (report.passed) {
    if (state !== "submitted") {
      throw new SettlementStateError(
        `complete requires job in "submitted" state, got "${state}"`,
        jobId,
        state,
      );
    }
    const txHash = await jobClient.complete(jobId, report.reasonHash);
    return { action: "complete", jobId, reasonHash: report.reasonHash, txHash };
  }

  // 出口 1：受理失败只在 Funded 态行使拒绝权（合约 §6、主导裁定）。
  if (state !== "funded") {
    throw new SettlementStateError(
      `reject requires job in "funded" state, got "${state}"`,
      jobId,
      state,
    );
  }
  const txHash = await jobClient.reject(jobId, report.reasonHash);
  return { action: "reject", jobId, reasonHash: report.reasonHash, txHash };
}
