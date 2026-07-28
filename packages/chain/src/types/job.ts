import type { Address, Hex } from "viem";

/**
 * 8183 Job 状态机（合约 §2.2）。链上状态只用于对账，真相源是 engine 的 SQLite。
 *
 * **六**态，与参考实现 `enum JobStatus { Open, Funded, Submitted, Completed,
 * Rejected, Expired }` 的 uint8 取值一一对应（`expired` = 5，`claimRefund` 后的终态）。
 */
export type JobState = "open" | "funded" | "submitted" | "completed" | "rejected" | "expired";

/** {@link JobClient.createJob} 的参数。 */
export interface CreateJobParams {
  readonly provider: Address;
  readonly evaluator: Address;
  readonly expiredAt: bigint;
  readonly description: string;
  /**
   * 案件 ID。createJob 时 jobId 尚未产生，幂等键退化为 `${caseId}:createJob`
   * （合约 §3 `IdempotencyRecord.key` 的注释）——所以这里必须由调用方给出。
   */
  readonly caseId: string;
}

/** {@link JobClient.createJob} 的返回值。 */
export interface CreateJobResult {
  readonly jobId: bigint;
  readonly txHash: Hex;
}

/** 链上 `getJob(jobId)` 返回的 Job 结构（参考实现 `struct Job`）。 */
export interface JobView {
  readonly id: bigint;
  readonly client: Address;
  readonly provider: Address;
  readonly evaluator: Address;
  readonly description: string;
  /** 6 位小数原子单位 */
  readonly budget: bigint;
  /** Unix 秒 */
  readonly expiredAt: bigint;
  readonly status: JobState;
  readonly hook: Address;
}

/**
 * 链上手续费率（basis point，分母 10000）。
 *
 * 合约 §2.4：engine 账本按净额对账，**严禁硬编码费率**，一律读链上 view。
 */
export interface JobFeeRates {
  readonly platformFeeBP: bigint;
  readonly evaluatorFeeBP: bigint;
}

/**
 * ERC-8183 参考合约客户端。金额一律为 6 位小数原子单位 bigint。
 *
 * 全部写方法幂等：进入即按 `${jobId}:${action}` 查 IdempotencyStore，
 * 命中直接返回既有 txHash、不发交易。
 *
 * 每个方法内部按 §2.1 角色映射选用对应钱包（client=marketplace /
 * provider=operator / evaluator=verifier），调用方不需要也不能指定钱包。
 */
export interface JobClient {
  /** client 钱包（MARKETPLACE_PRIVATE_KEY）。 */
  createJob(p: CreateJobParams): Promise<CreateJobResult>;
  /** provider 钱包（OPERATOR_PRIVATE_KEY）——参考实现只允许 provider 调。 */
  setBudget(jobId: bigint, amountAtomic: bigint): Promise<Hex>;
  /**
   * client 钱包（MARKETPLACE_PRIVATE_KEY），内含 USDC approve。
   *
   * `expectedBudgetAtomic` 是 §2.5 抢跑缓解所需：发交易前紧邻复读链上 budget，
   * 与预期不符即中止。
   */
  fund(jobId: bigint, expectedBudgetAtomic: bigint): Promise<Hex>;
  /** provider 钱包（OPERATOR_PRIVATE_KEY）。 */
  submit(jobId: bigint, deliverableHash: Hex): Promise<Hex>;
  /** evaluator 钱包（VERIFIER_PRIVATE_KEY），仅 Submitted 态可调。 */
  complete(jobId: bigint, reasonHash: Hex): Promise<Hex>;
  /** evaluator 钱包（VERIFIER_PRIVATE_KEY），Funded 或 Submitted 态可调。 */
  reject(jobId: bigint, reasonHash: Hex): Promise<Hex>;
  /** client 钱包；链上无 msg.sender 检查（permissionless），我方仍由 client 调。 */
  claimRefund(jobId: bigint): Promise<Hex>;
  getJob(jobId: bigint): Promise<JobView>;
  getJobState(jobId: bigint): Promise<JobState>;
  /** 读链上费率，账本按实际值算净额。 */
  getFeeRates(): Promise<JobFeeRates>;
}
