import type { Hex } from "viem";

/**
 * 链上写操作的动作名。幂等键为 `${jobId}:${action}`。
 *
 * 逐字照录 `docs/design/contracts-vertical-slice.md` §3。
 */
export type ChainAction =
  | "createJob"
  | "setBudget"
  | "fund"
  | "submit"
  | "complete"
  | "reject"
  | "claimRefund";

/**
 * 一条已提交的链上写操作记录。
 *
 * chain 只读不写状态：真相源是 engine 的 SQLite（`tx_log`），
 * chain 侧仅通过 {@link IdempotencyStore} 接口读写，绝不 import engine。
 */
export interface IdempotencyRecord {
  /** `${jobId}:${action}`，createJob 等 jobId 未知时用 `${caseId}:${action}` */
  readonly key: string;
  readonly txHash: Hex;
  /** ISO8601 UTC */
  readonly submittedAt: string;
}

/**
 * 幂等存储接口：chain 定义、engine 实现，由调用方注入。
 */
export interface IdempotencyStore {
  /** 已执行过则返回既有记录，chain 直接返回它、绝不重发交易。 */
  lookup(key: string): Promise<IdempotencyRecord | null>;
  /** 发交易成功后立即写入。同 key 重复写入必须报错而非静默覆盖。 */
  record(rec: IdempotencyRecord): Promise<void>;
}

/**
 * 构造幂等键。jobId 未知（createJob 阶段）时传入 caseId 字符串。
 *
 * @param scope - jobId（bigint）或 caseId（string）
 * @param action - 链上动作名
 */
export function idempotencyKey(scope: bigint | string, action: ChainAction): string {
  return `${typeof scope === "bigint" ? scope.toString() : scope}:${action}`;
}
