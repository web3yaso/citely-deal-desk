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

import type {
  CreateJobParams,
  CreateJobResult,
  JobClient,
  JobFeeRates,
  JobState,
  JobView,
  ModuleCheckResult,
  ModuleId,
  ModuleResponse,
  X402Client,
} from "@citely/chain";
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

/** 录制快照里缺 Gateway 回执，无法冒充一次采购。 */
export class MissingReceiptError extends Error {
  public constructor() {
    super(
      "录制快照里没有 Gateway 结算 ID：账本的 module_fee / royalty 两行以它为 ref，" +
        "拿不到就渲染不出来。请先跑 pnpm -F @citely/demo record:module 录一份真实响应，" +
        "而不是让演示编一个回执号。",
    );
    this.name = "MissingReceiptError";
  }
}

/** 替身被要求采购一个与快照不符的 Module。 */
export class UnexpectedModuleError extends Error {
  public constructor(requested: string, recorded: string) {
    super(
      `dry-run 采购替身只有 ${recorded} 的录制快照，却被要求采购 ${requested}——` +
        "绝不拿另一个 Module 的响应冒充",
    );
    this.name = "UnexpectedModuleError";
  }
}

export interface DryRunX402Options {
  /** 录制的 Module 响应。 */
  readonly response: ModuleResponse;
  /** 录制里的 Gateway 结算 ID；缺失即抛 {@link MissingReceiptError}。 */
  readonly settlementId: string | undefined;
  /** 快照对应的实付金额（最小单位）。 */
  readonly paidAtomic: bigint;
}

/**
 * 建一个内存版 `X402Client`。
 *
 * `--dry-run` 的定义是"不发链上交易、**不付费**"，而 `POST /modules/:id/check`
 * 是 x402 付费端点——所以离线跑必须有替身，否则 dry-run 根本无法离线。
 *
 * 两道闸，任何一道不满足就**响亮失败**而不是给个占位值：
 * 1. 没有 Gateway 回执 → 账本那两行渲染不出来，不编回执号；
 * 2. 要买的 Module 与快照不符 → 不拿另一个 Module 的响应冒充。
 *
 * @param options - 录制快照与回执
 * @returns X402Client 替身与调用记录
 * @throws {MissingReceiptError} 快照缺回执
 */
export function createDryRunX402Client(options: DryRunX402Options): {
  readonly client: X402Client;
  readonly calls: ModuleId[];
} {
  if (options.settlementId === undefined || options.settlementId === "") {
    throw new MissingReceiptError();
  }
  const settlementId = options.settlementId;
  const calls: ModuleId[] = [];

  const client: X402Client = {
    check: async (moduleId, _dealInput): Promise<ModuleCheckResult> => {
      if (moduleId !== options.response.module) {
        throw new UnexpectedModuleError(moduleId, options.response.module);
      }
      calls.push(moduleId);
      return await Promise.resolve({
        response: options.response,
        settlementId,
        paidAtomic: options.paidAtomic,
      });
    },
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
