/**
 * `--dry-run` 专用替身：不发交易、不付费、不联网。
 *
 * **这些替身只在 `--dry-run` 分支里被构造**（`run-vertical-slice.ts` 里是
 * 两条互斥分支）。真实模式一律用 chain 的 `createJobClient` / `createX402Client`——
 * 任何"真实模式下悄悄退回替身"的路径都是静默降级，不许存在。
 *
 * 替身仍然**忠实执行 8183 的状态机与授权矩阵**（合约 §2.3）：状态不对就抛错。
 * 一个不检查状态的替身会让演示在 dry-run 下"过"、上真链才炸，那就白排练了。
 */

import type { CreateJobParams, CreateJobResult, JobClient, JobFeeRates, JobState, JobView } from "@citely/chain";
import type { Address, Hex } from "viem";

import type { PaymentExecutor, PlannedPayment } from "@citely/marketplace";

/** 替身遇到不合法的状态迁移。 */
export class DryRunStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DryRunStateError";
  }
}

/** 记录下来的一次链上写操作，供演示结尾打印。 */
export interface RecordedCall {
  readonly action: string;
  readonly jobId: bigint | null;
  readonly txHash: Hex;
}

export interface DryRunJobClientOptions {
  readonly provider: Address;
  readonly evaluator: Address;
  readonly client: Address;
  /** 链上费率。dry-run 下也**不硬编码进业务代码**，由这里给出、账本照读。 */
  readonly fees: JobFeeRates;
}

/** 由动作名派生一个稳定的假 txHash——一眼能看出是排练不是真交易。 */
function fakeTxHash(seq: number): Hex {
  return `0x${"de".repeat(30)}${seq.toString(16).padStart(4, "0")}` as Hex;
}

/**
 * 建一个内存版 `JobClient`。
 *
 * @param options - 三方地址与费率
 * @returns JobClient 替身与调用记录
 */
export function createDryRunJobClient(options: DryRunJobClientOptions): {
  readonly client: JobClient;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let nextJobId = 1n;
  const jobs = new Map<string, { view: JobView }>();

  const record = (action: string, jobId: bigint | null): Hex => {
    const txHash = fakeTxHash(calls.length + 1);
    calls.push({ action, jobId, txHash });
    return txHash;
  };

  const mustGet = (jobId: bigint): { view: JobView } => {
    const job = jobs.get(jobId.toString());
    if (job === undefined) throw new DryRunStateError(`unknown jobId ${String(jobId)}`);
    return job;
  };

  const transition = (jobId: bigint, allowed: readonly JobState[], next: JobState, action: string): Hex => {
    const job = mustGet(jobId);
    if (!allowed.includes(job.view.status)) {
      throw new DryRunStateError(
        `${action} 要求 Job 处于 ${allowed.join("|")} 态，实际为 ${job.view.status}`,
      );
    }
    jobs.set(jobId.toString(), { view: { ...job.view, status: next } });
    return record(action, jobId);
  };

  // 全部方法写成 async：真实 JobClient 的错误是 rejection，替身同步 throw 的话，
  // 用 .catch() 收敛错误的调用方在 dry-run 下会漏掉异常、上真链才发现。
  const client: JobClient = {
    createJob: async (p: CreateJobParams): Promise<CreateJobResult> => {
      const jobId = nextJobId;
      nextJobId += 1n;
      jobs.set(jobId.toString(), {
        view: {
          id: jobId,
          client: options.client,
          provider: p.provider,
          evaluator: p.evaluator,
          description: p.description,
          budget: 0n,
          expiredAt: p.expiredAt,
          status: "open",
          hook: "0x0000000000000000000000000000000000000000",
        },
      });
      return await Promise.resolve({ jobId, txHash: record("createJob", jobId) });
    },
    setBudget: async (jobId, amountAtomic) => {
      const job = mustGet(jobId);
      if (job.view.status !== "open") {
        throw new DryRunStateError(`setBudget 要求 open 态，实际为 ${job.view.status}`);
      }
      jobs.set(jobId.toString(), { view: { ...job.view, budget: amountAtomic } });
      return await Promise.resolve(record("setBudget", jobId));
    },
    fund: async (jobId, expectedBudgetAtomic) => {
      const job = mustGet(jobId);
      // §2.5 抢跑缓解：发交易前紧邻复读 budget，与预期不符即中止。
      if (job.view.budget !== expectedBudgetAtomic) {
        throw new DryRunStateError(
          `fund 前复读 budget 不符：链上 ${String(job.view.budget)} != 预期 ${String(expectedBudgetAtomic)}`,
        );
      }
      return await Promise.resolve(transition(jobId, ["open"], "funded", "fund"));
    },
    submit: async (jobId) => await Promise.resolve(transition(jobId, ["funded"], "submitted", "submit")),
    complete: async (jobId) =>
      await Promise.resolve(transition(jobId, ["submitted"], "completed", "complete")),
    reject: async (jobId) =>
      await Promise.resolve(transition(jobId, ["funded", "submitted"], "rejected", "reject")),
    claimRefund: async (jobId) =>
      await Promise.resolve(transition(jobId, ["funded", "submitted"], "expired", "claimRefund")),
    getJob: async (jobId) => await Promise.resolve(mustGet(jobId).view),
    getJobState: async (jobId) => await Promise.resolve(mustGet(jobId).view.status),
    getFeeRates: async () => await Promise.resolve(options.fees),
  };

  return { client, calls };
}

/** dry-run 的付款出口：只记账，不转账。 */
export function createDryRunPaymentExecutor(): {
  readonly executor: PaymentExecutor;
  readonly payments: PlannedPayment[];
} {
  const payments: PlannedPayment[] = [];
  const executor: PaymentExecutor = {
    payOut: (payment) => {
      payments.push(payment);
      return Promise.resolve(fakeTxHash(9000 + payments.length));
    },
  };
  return { executor, payments };
}
