/**
 * 案件状态机（合约 §3，**状态字符串逐字照录**）。
 *
 * ```
 * case:      intake → decomposed → assessing → conditions_ready → submitted → settled | rejected
 * partyTask: pending → assessing → awaiting_data(x402_receipt) → resolved(verdict)
 * ```
 *
 * 状态三纪律第 1 条：这里是唯一真相源，链上状态只用于**对账**——
 * {@link applyJobState} 是链上态进入本状态机的唯一入口，且它对 8183 的
 * **六**态做穷尽匹配（合约 §2.2），没有 `default` 分支：
 * 链上哪天多一个状态，TypeScript 会在编译期红给你看，而不是运行期静默吞掉。
 */

import type { JobState } from "@citely/chain/types";

/** 案件主状态。逐字照录合约 §3。 */
export type CaseState =
  | "intake"
  | "decomposed"
  | "assessing"
  | "conditions_ready"
  | "submitted"
  | "settled"
  | "rejected";

/** 角色任务状态。逐字照录合约 §3。 */
export type PartyTaskState = "pending" | "assessing" | "awaiting_data" | "resolved";

/**
 * 终局出口（v2.2 §2.2 五出口路由表）。
 *
 * **`timeout_refund` 与 `verifier_rejected` 必须分开**：两者的 `CaseState`
 * 都是 `rejected`，但一个是"超 expiredAt 由 client `claimRefund`、链上不扣费"，
 * 另一个是"验证器行使 `reject` 权、escrow 退回 client"。混成一个分支会让
 * 账本 category 与对外口径记错（合约 §2.3 / §2.4）。
 */
export type CaseExitReason =
  /** 出口 1：受理失败，验证器在 Funded 态 reject。 */
  | "intake_rejected"
  /** 出口 2/4：SA 已提交并被验证器 complete（含含 ESCALATE 腿的 SA）。 */
  | "completed"
  /** 验证器在 Submitted 态 reject。 */
  | "verifier_rejected"
  /** 出口 5：超时，`claimRefund` 后链上进入 `expired`。 */
  | "timeout_refund";

const CASE_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  intake: ["decomposed", "rejected"],
  decomposed: ["assessing", "rejected"],
  // 自环：x402 采购到新数据后重跑判定（v2.2 §2.2 出口 3）。
  assessing: ["assessing", "conditions_ready", "rejected"],
  conditions_ready: ["submitted", "rejected"],
  submitted: ["settled", "rejected"],
  settled: [],
  rejected: [],
};

const PARTY_TASK_TRANSITIONS: Record<PartyTaskState, readonly PartyTaskState[]> = {
  pending: ["assessing"],
  assessing: ["awaiting_data", "resolved"],
  // 采购到数据后回到 assessing 重跑。
  awaiting_data: ["assessing", "resolved"],
  resolved: [],
};

/** 非法状态跃迁。永远抛错，绝不静默忽略——状态机是唯一真相源。 */
export class CaseStateError extends Error {
  public constructor(kind: string, from: string, to: string) {
    super(`illegal ${kind} transition: ${from} -> ${to}`);
    this.name = "CaseStateError";
  }
}

/** 该案件状态是否为终局。 */
export function isTerminalCaseState(state: CaseState): boolean {
  return CASE_TRANSITIONS[state].length === 0;
}

/**
 * 校验案件状态跃迁。
 *
 * @throws {CaseStateError} 跃迁不在 {@link CASE_TRANSITIONS} 表里
 */
export function assertCaseTransition(from: CaseState, to: CaseState): void {
  if (!CASE_TRANSITIONS[from].includes(to)) throw new CaseStateError("case", from, to);
}

/**
 * 校验角色任务状态跃迁。
 *
 * @throws {CaseStateError} 跃迁不合法
 */
export function assertPartyTaskTransition(from: PartyTaskState, to: PartyTaskState): void {
  if (!PARTY_TASK_TRANSITIONS[from].includes(to)) throw new CaseStateError("partyTask", from, to);
}

/** 链上状态对账的结论：要不要改案件状态、改成什么、出口是什么。 */
export interface JobStateMapping {
  /** `null` = 链上尚未终局，案件状态不因这次对账而改变。 */
  readonly caseState: CaseState | null;
  readonly exitReason: CaseExitReason | null;
}

/**
 * 8183 链上状态 → 案件状态机（合约 §2.2 的**六**态，穷尽匹配无 `default`）。
 *
 * - `open` / `funded` / `submitted`：链上未终局，案件状态由引擎自己推进；
 * - `completed`：验证器三检通过并 `complete` → 案件 `settled`；
 * - `rejected`：验证器行使 `reject` 权 → 案件 `rejected`（`verifier_rejected`）；
 * - `expired`：**超时出口**（v2.2 §2.2 第 5 条），`claimRefund` 后的终态 →
 *   案件 `rejected`，但出口是 `timeout_refund`，与验证器拒绝**不是同一件事**。
 *
 * @param jobState - `JobClient.getJobState()` 的返回值
 * @param submitted - 提交 SA 之前即被 reject 属于出口 1（受理失败）
 */
export function applyJobState(jobState: JobState, submitted: boolean): JobStateMapping {
  switch (jobState) {
    case "open":
    case "funded":
    case "submitted":
      return { caseState: null, exitReason: null };
    case "completed":
      return { caseState: "settled", exitReason: "completed" };
    case "rejected":
      return {
        caseState: "rejected",
        exitReason: submitted ? "verifier_rejected" : "intake_rejected",
      };
    case "expired":
      return { caseState: "rejected", exitReason: "timeout_refund" };
  }
}
