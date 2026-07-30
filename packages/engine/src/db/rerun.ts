/**
 * 同一案件重跑的幂等骨架（《模块拆分》§三 D6 的实证载体）。
 *
 * 主导 2026-07-29 亲手跑幂等实证时发现：演示脚本每次都**新建案件**（jobId 都是 1、
 * 两次各记 4 行账本共 8 行），所以它根本走不到幂等那条路——
 * "跑三次得到三份不同的账"不是幂等，是重复入账。
 *
 * 本文件把"重跑"这件事变成一个**可断言的确定性过程**：
 * 每一步链上写操作都先 `lookup`，命中即复用既有 txHash；账本重复入账被幂等键挡住。
 * 它不发任何网络请求——链上动作由调用方注入的 {@link ChainWriter} 执行，
 * 所以既能接真链，也能在 CI 里用假实现跑。
 */

import { idempotencyKey, type ChainAction, type IdempotencyStore } from "@citely/chain/types";
import type { Hex } from "viem";

/** 执行一次真实链上写操作。只在幂等表未命中时被调用。 */
export type ChainWriter = (action: ChainAction) => Promise<Hex>;

/** 一步链上写操作的结果。 */
export interface ChainStepResult {
  readonly action: ChainAction;
  readonly key: string;
  readonly txHash: Hex;
  /** `true` = 命中幂等表、**没有发交易**；`false` = 本次真的发了交易。 */
  readonly reused: boolean;
}

/**
 * 执行一步链上写操作，**先查幂等表**。
 *
 * 这就是状态三纪律第 3 条的落点：命中即返回既有 txHash，绝不重发交易。
 *
 * @param store - 幂等存储（engine 的 `SqliteIdempotencyStore`）
 * @param scope - jobId，或 createJob 阶段尚无 jobId 时的 caseId
 * @param action - 链上动作名
 * @param writer - 真正发交易的函数；命中时**不会被调用**
 */
export async function chainStep(
  store: IdempotencyStore,
  scope: bigint | string,
  action: ChainAction,
  writer: ChainWriter,
): Promise<ChainStepResult> {
  // 键一律由 chain 导出的 idempotencyKey() 构造，engine 不自己拼字符串。
  const key = idempotencyKey(scope, action);
  const existing = await store.lookup(key);
  if (existing !== null) {
    return { action, key, txHash: existing.txHash, reused: true };
  }
  const txHash = await writer(action);
  await store.record({ key, txHash, submittedAt: new Date().toISOString() });
  return { action, key, txHash, reused: false };
}

/** 一次完整重跑的汇总。 */
export interface RerunSummary {
  readonly steps: readonly ChainStepResult[];
  /** 本次真的发出去的交易数。**第二次及以后必须是 0。** */
  readonly sentCount: number;
  /** 命中幂等表、被复用的步数。 */
  readonly reusedCount: number;
}

export function summarizeRerun(steps: readonly ChainStepResult[]): RerunSummary {
  return {
    steps,
    sentCount: steps.filter((s) => !s.reused).length,
    reusedCount: steps.filter((s) => s.reused).length,
  };
}

/**
 * 按顺序跑一串链上写操作，返回汇总。
 *
 * 串行而不是并发：链上动作有顺序依赖（`setBudget` → `fund` → `submit` → `complete`），
 * 而且"禁止隐式 promise 链"要求执行顺序是显式的。
 */
export async function runChainSteps(
  store: IdempotencyStore,
  plan: readonly { readonly scope: bigint | string; readonly action: ChainAction }[],
  writer: ChainWriter,
): Promise<RerunSummary> {
  const steps: ChainStepResult[] = [];
  for (const item of plan) {
    steps.push(await chainStep(store, item.scope, item.action, writer));
  }
  return summarizeRerun(steps);
}
