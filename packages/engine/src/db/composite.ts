/**
 * 多角色**显式组合状态表**（v2.3 §3.1）。
 *
 * > 案件状态 = 主 Job 状态 × 各角色任务状态 × 子 Job 状态的**显式组合状态表**，
 * > 禁止隐式 promise 链。
 *
 * 这条纪律的意思不是"别写 async"，而是：**案件此刻处于什么状态，必须能由三组
 * 已持久化的状态值一次算出来**，而不是散落在"哪几个 Promise 已经 resolve 了"里。
 * 进程崩了重启、或者多角色判定并发完成的顺序变了，算出来的案件状态必须一模一样。
 *
 * 所以本文件只有两个纯函数：
 * - {@link assertLegalComposite}：非法组合**报错**，不静默通过；
 * - {@link deriveCaseState}：合法组合 → 唯一的案件状态。
 *
 * 两者都不碰数据库、不发请求、不 await 任何东西。
 */

import type { JobState } from "@citely/chain/types";

import type { CaseState, PartyTaskState } from "./state.js";

/** 组合状态的三个维度。 */
export interface CompositeState {
  /** 主 Job 的链上状态（对账得来，不是真相源）。 */
  readonly job: JobState;
  /** 各角色任务状态。空数组 = 尚未分解。 */
  readonly partyTasks: readonly PartyTaskState[];
  /**
   * 子 Job（出口 4 的 Review Job）的链上状态。没有升级腿时为 `null`。
   * Review Job 由 Marketplace 注资，我方只读它的状态。
   */
  readonly reviewJob: JobState | null;
}

/** 组合状态非法——这个组合在业务上不可能出现，出现即有 bug。 */
export class IllegalCompositeStateError extends Error {
  public readonly composite: CompositeState;

  public constructor(reason: string, composite: CompositeState) {
    super(`illegal composite case state: ${reason}`);
    this.name = "IllegalCompositeStateError";
    this.composite = composite;
  }
}

/** 主 Job 是否已终局。 */
function isJobTerminal(job: JobState): boolean {
  return job === "completed" || job === "rejected" || job === "expired";
}

function allResolved(tasks: readonly PartyTaskState[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t === "resolved");
}

function allPending(tasks: readonly PartyTaskState[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t === "pending");
}

/**
 * 校验组合是否合法。**非法必须报错，不许静默通过**。
 *
 * 规则（每条都能说出"为什么这个组合不可能"）：
 * 1. 未分解（无角色任务）时主 Job 不可能已经 `submitted`/`completed`——
 *    没有判定过任何角色，拿什么 deliverable 去提交？
 * 2. 主 Job 已 `submitted` 或 `completed` 时，**所有**角色任务必须 `resolved`——
 *    SA 覆盖 rubric 全部判定项是验证器第 3 检的内容，漏一个就该在这里炸，
 *    而不是等验证器 reject 之后再回头查。
 * 3. 子 Job 只可能在主 Job 至少 `submitted` 之后存在——Review Job 随 SA 一起提交。
 * 4. `rejected`/`expired` 是终局：允许角色任务停在任意状态（受理失败与超时
 *    都可能发生在判定完成之前），所以这两个态**不施加角色任务约束**。
 *
 * @throws {IllegalCompositeStateError} 组合不可能出现
 */
export function assertLegalComposite(composite: CompositeState): void {
  const { job, partyTasks, reviewJob } = composite;

  if (partyTasks.length === 0 && (job === "submitted" || job === "completed")) {
    throw new IllegalCompositeStateError(
      `job=${job} with no party tasks (nothing was adjudicated)`,
      composite,
    );
  }

  if ((job === "submitted" || job === "completed") && !allResolved(partyTasks)) {
    throw new IllegalCompositeStateError(
      `job=${job} but not every party task is resolved`,
      composite,
    );
  }

  if (reviewJob !== null && (job === "open" || job === "funded")) {
    throw new IllegalCompositeStateError(
      `review job exists while main job is still ${job} (it ships with the SA)`,
      composite,
    );
  }
}

/**
 * 组合状态 → 唯一的案件状态（合约 §3 的字符串，逐字）。
 *
 * 推导顺序：**先看主 Job 的终局态**（链上说了算的部分），再看角色任务的进度。
 *
 * | 主 Job | 角色任务 | 案件状态 |
 * |---|---|---|
 * | `completed` | 全 resolved | `settled` |
 * | `rejected` / `expired` | 任意 | `rejected` |
 * | `submitted` | 全 resolved | `submitted` |
 * | `open` / `funded` | 空 | `intake` |
 * | `open` / `funded` | 全 pending | `decomposed` |
 * | `open` / `funded` | 有进行中的 | `assessing` |
 * | `open` / `funded` | 全 resolved | `conditions_ready` |
 *
 * @throws {IllegalCompositeStateError} 组合非法
 */
export function deriveCaseState(composite: CompositeState): CaseState {
  assertLegalComposite(composite);
  const { job, partyTasks } = composite;

  switch (job) {
    case "completed":
      return "settled";
    case "rejected":
    case "expired":
      // 两者的**出口**不同（verifier_rejected vs timeout_refund，见 state.ts），
      // 但案件状态字符串同为 rejected——合约 §3 没有第七个状态可用。
      return "rejected";
    case "submitted":
      return "submitted";
    case "open":
    case "funded":
      if (partyTasks.length === 0) return "intake";
      if (allResolved(partyTasks)) return "conditions_ready";
      if (allPending(partyTasks)) return "decomposed";
      return "assessing";
  }
}

/**
 * 案件是否已终局（无论哪个出口）。
 *
 * 用主 Job 的终局性判断，而不是数角色任务——链上终局了就是终局了，
 * 哪怕还有角色任务卡在 `awaiting_data`（超时出口正是这种形态）。
 */
export function isCompositeTerminal(composite: CompositeState): boolean {
  assertLegalComposite(composite);
  return isJobTerminal(composite.job);
}
