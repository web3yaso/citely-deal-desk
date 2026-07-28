import type { Address, Hex } from "viem";

/**
 * 8183 Job 状态机（合约 §2）。链上状态只用于对账，真相源是 engine 的 SQLite。
 */
export type JobState = "open" | "funded" | "submitted" | "completed" | "rejected";

/** {@link JobClient.createJob} 的参数。 */
export interface CreateJobParams {
  readonly provider: Address;
  readonly evaluator: Address;
  readonly expiredAt: bigint;
  readonly description: string;
}

/** {@link JobClient.createJob} 的返回值。 */
export interface CreateJobResult {
  readonly jobId: bigint;
  readonly txHash: Hex;
}

/**
 * ERC-8183 参考合约客户端。金额一律为 6 位小数原子单位 bigint。
 *
 * 全部写方法幂等：进入即按 `${jobId}:${action}` 查 IdempotencyStore，
 * 命中直接返回既有 txHash、不发交易。
 */
export interface JobClient {
  createJob(p: CreateJobParams): Promise<CreateJobResult>;
  setBudget(jobId: bigint, amountAtomic: bigint): Promise<Hex>;
  /** 内含 USDC approve。 */
  fund(jobId: bigint): Promise<Hex>;
  submit(jobId: bigint, deliverableHash: Hex): Promise<Hex>;
  /** verifier 专用。 */
  complete(jobId: bigint, reasonHash: Hex): Promise<Hex>;
  /** verifier 专用。 */
  reject(jobId: bigint, reasonHash: Hex): Promise<Hex>;
  getJobState(jobId: bigint): Promise<JobState>;
}
