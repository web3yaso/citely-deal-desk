import {
  erc20Abi,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

import { agenticCommerceAbi } from "./abi/agentic-commerce.js";
import { ChainError, wrapChainError } from "./errors.js";
import { idempotencyKey, type ChainAction, type IdempotencyStore } from "./types/idempotency.js";
import type {
  CreateJobParams,
  CreateJobResult,
  JobClient,
  JobFeeRates,
  JobState,
  JobView,
} from "./types/job.js";

/** 我方一律传空 `optParams`：不用任何可选扩展。 */
export const EMPTY_OPT_PARAMS = "0x" as const;

/** `createJob` 的 hook 参数固定传零地址：不用 hook，也不给未白名单的 hook 机会。 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * `createJob` 的最短有效期：参考实现
 * `if (expiredAt <= block.timestamp + 5 minutes) revert ExpiryTooShort();`
 *
 * 注意是**严格大于**：正好 5 分钟会被 revert。
 */
export const MIN_EXPIRY_SECONDS = 300n;

/**
 * 演示用的缺省有效期 10 分钟。
 *
 * 为什么不是 24 小时：现场要展示超时退款（出口 5）时，24 小时的 Job 根本等不到；
 * 10 分钟既过得了 5 分钟下限，又能当场等完。
 */
export const DEMO_EXPIRY_SECONDS = 600n;

/**
 * 由「从现在起多少秒」算出链上 `expiredAt`，并在本地就挡住过短的值。
 *
 * 宁可在这里抛一句人话，也不要花掉一次 gas 去换链上一个 `ExpiryTooShort`。
 * 留 30 秒余量：从算出时间到交易真正上链之间有几个区块的漂移，贴着下限传必然翻车。
 *
 * @param seconds - 从现在起的秒数
 * @param nowSeconds - 当前时间（Unix 秒），默认取本机时钟
 * @returns 绝对 `expiredAt`（Unix 秒）
 */
export function expiryFromNow(
  seconds: bigint,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): bigint {
  const safeFloor = MIN_EXPIRY_SECONDS + 30n;
  if (seconds < safeFloor) {
    throw new ChainError(
      `Job 有效期 ${seconds.toString()} 秒过短：链上要求严格大于 ` +
        `${MIN_EXPIRY_SECONDS.toString()} 秒（ExpiryTooShort），` +
        `本地再留 30 秒出块漂移余量，请传至少 ${safeFloor.toString()} 秒`,
    );
  }
  return nowSeconds + seconds;
}

/** uint8 `JobStatus` → 领域态。下标即链上枚举值（合约 §2.2，六态）。 */
const JOB_STATES: readonly JobState[] = [
  "open",
  "funded",
  "submitted",
  "completed",
  "rejected",
  "expired",
];

/**
 * 把链上 `JobStatus`（uint8）映射为 {@link JobState}。
 *
 * 未知取值必须炸而不是猜——链上多出一个态意味着合约不是我们校对过的那份。
 *
 * @param status - 链上 uint8 状态值
 */
export function toJobState(status: number): JobState {
  const state = JOB_STATES[status];
  if (state === undefined) {
    throw new ChainError(
      `未知的链上 JobStatus=${String(status)}：ABI 与部署字节码可能不匹配，先跑 spike ①`,
    );
  }
  return state;
}

/** 按 §2.1 角色映射注入的三把钱包。三者地址必须互不相同。 */
export interface JobRoleWallets {
  /** 8183 client：createJob / approve+fund / claimRefund（MARKETPLACE_PRIVATE_KEY） */
  readonly client: WalletClient<Transport, Chain, PrivateKeyAccount>;
  /** 8183 provider：setBudget / submit（OPERATOR_PRIVATE_KEY） */
  readonly provider: WalletClient<Transport, Chain, PrivateKeyAccount>;
  /** 8183 evaluator：complete / reject（VERIFIER_PRIVATE_KEY） */
  readonly evaluator: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

export interface JobClientDeps {
  readonly jobContract: Address;
  /** 8183 的 `paymentToken`，`fund` 前 approve 用。 */
  readonly usdc: Address;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly wallets: JobRoleWallets;
  /** 幂等存储由 engine 注入（chain 不许 import engine）。 */
  readonly store: IdempotencyStore;
}

interface WriteContext {
  readonly action: ChainAction;
  readonly key: string;
  readonly jobId?: bigint;
  readonly caseId?: string;
}

function assertDistinctWallets(wallets: JobRoleWallets): void {
  const entries = [
    ["client", wallets.client.account.address],
    ["provider", wallets.provider.account.address],
    ["evaluator", wallets.evaluator.account.address],
  ] as const;
  const seen = new Map<string, string>();
  for (const [role, address] of entries) {
    const previous = seen.get(address.toLowerCase());
    if (previous !== undefined) {
      throw new ChainError(
        `8183 角色 ${previous} 与 ${role} 用了同一个地址：三把密钥必须物理分离（§2.1）`,
      );
    }
    seen.set(address.toLowerCase(), role);
  }
}

function assertState(actual: JobState, allowed: readonly JobState[], ctx: WriteContext): void {
  if (!allowed.includes(actual)) {
    const jobIdPart = ctx.jobId === undefined ? {} : { jobId: ctx.jobId };
    throw new ChainError(
      `${ctx.action} 要求 Job 处于 ${allowed.join("|")} 态，实际为 ${actual}`,
      { action: ctx.action, ...jobIdPart, idempotencyKey: ctx.key },
    );
  }
}

/**
 * 创建 8183 Job 客户端。
 *
 * 每个写方法按 §2.1 用对应角色的钱包发交易，调用方无从指定——单钱包写死会让
 * `Unauthorized` 在 testnet 上才暴露出来。
 *
 * @param deps - 合约地址、三角色钱包、幂等存储
 */
export function createJobClient(deps: JobClientDeps): JobClient {
  assertDistinctWallets(deps.wallets);
  const { jobContract, usdc, publicClient, wallets, store } = deps;

  async function readJob(jobId: bigint, action?: ChainAction): Promise<JobView> {
    try {
      const job = await publicClient.readContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "getJob",
        args: [jobId],
      });
      return { ...job, status: toJobState(job.status) };
    } catch (error: unknown) {
      if (error instanceof ChainError) throw error;
      throw wrapChainError(error, "读取 getJob 失败", {
        ...(action === undefined ? {} : { action }),
        jobId,
      });
    }
  }

  /** 幂等前置查询：命中就别再做任何链上预读（省 RPC，也避免重复报错）。 */
  async function lookupTxHash(key: string): Promise<Hex | null> {
    const existing = await store.lookup(key);
    return existing === null ? null : existing.txHash;
  }

  /**
   * 幂等外壳：命中既有记录直接返回，不发交易；未命中才发、发出即记录。
   *
   * 记录时机在「拿到 txHash 之后、等回执之前」——重试不重复付款优先于
   * 「失败的交易不入账」：真的 revert 了由 engine 侧按 txHash 对账处置。
   */
  async function sendWrite(ctx: WriteContext, send: () => Promise<Hex>): Promise<Hex> {
    const existing = await store.lookup(ctx.key);
    if (existing !== null) {
      return existing.txHash;
    }
    let txHash: Hex;
    try {
      txHash = await send();
    } catch (error: unknown) {
      if (error instanceof ChainError) throw error;
      throw wrapChainError(error, `${ctx.action} 发送交易失败`, {
        action: ctx.action,
        ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId }),
        ...(ctx.caseId === undefined ? {} : { caseId: ctx.caseId }),
        idempotencyKey: ctx.key,
      });
    }
    await store.record({ key: ctx.key, txHash, submittedAt: new Date().toISOString() });
    await waitForSuccess(txHash, ctx);
    return txHash;
  }

  async function waitForSuccess(txHash: Hex, ctx: WriteContext): Promise<void> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new ChainError(
        `${ctx.action} 交易上链后 revert`,
        {
          action: ctx.action,
          ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId }),
          ...(ctx.caseId === undefined ? {} : { caseId: ctx.caseId }),
          idempotencyKey: ctx.key,
          txHash,
        },
      );
    }
  }

  async function jobIdFromTx(txHash: Hex, ctx: WriteContext): Promise<bigint> {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const [event] = parseEventLogs({
      abi: agenticCommerceAbi,
      eventName: "JobCreated",
      logs: receipt.logs,
    });
    if (event === undefined) {
      throw new ChainError("createJob 回执里没有 JobCreated 事件", {
        action: "createJob",
        ...(ctx.caseId === undefined ? {} : { caseId: ctx.caseId }),
        idempotencyKey: ctx.key,
        txHash,
      });
    }
    return event.args.jobId;
  }

  async function createJob(p: CreateJobParams): Promise<CreateJobResult> {
    const ctx: WriteContext = {
      action: "createJob",
      key: idempotencyKey(p.caseId, "createJob"),
      caseId: p.caseId,
    };
    const txHash = await sendWrite(ctx, async () =>
      wallets.client.writeContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "createJob",
        // hook 传零地址：我方不用 hook，也不给未白名单的 hook 任何机会。
        args: [p.provider, p.evaluator, p.expiredAt, p.description, ZERO_ADDRESS],
      }),
    );
    return { jobId: await jobIdFromTx(txHash, ctx), txHash };
  }

  async function setBudget(jobId: bigint, amountAtomic: bigint): Promise<Hex> {
    const ctx: WriteContext = { action: "setBudget", key: idempotencyKey(jobId, "setBudget"), jobId };
    if (amountAtomic <= 0n) {
      throw new ChainError("setBudget 金额必须为正（链上 ZeroBudget）", {
        action: "setBudget",
        jobId,
      });
    }
    return sendWrite(ctx, async () =>
      // setBudget 只有 provider 能调（参考实现 Unauthorized），故用运营钱包。
      wallets.provider.writeContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "setBudget",
        args: [jobId, amountAtomic, EMPTY_OPT_PARAMS],
      }),
    );
  }

  /** §2.5 抢跑缓解：approve 与 fund 之前紧邻复读链上 budget，与预期不符即中止。 */
  async function fund(jobId: bigint, expectedBudgetAtomic: bigint): Promise<Hex> {
    const ctx: WriteContext = { action: "fund", key: idempotencyKey(jobId, "fund"), jobId };
    const existing = await lookupTxHash(ctx.key);
    if (existing !== null) {
      return existing;
    }
    const job = await readJob(jobId, "fund");
    assertState(job.status, ["open"], ctx);
    if (job.budget !== expectedBudgetAtomic) {
      // 参考实现没有 EIP 正文里的 expectedBudget 检查，provider 可在读与付之间抬价。
      throw new ChainError(
        `fund 前复读链上 budget 与预期不符：链上 ${job.budget.toString()}，` +
          `预期 ${expectedBudgetAtomic.toString()}（疑似抢跑，已中止）`,
        { action: "fund", jobId, idempotencyKey: ctx.key },
      );
    }
    await approveUsdc(job.budget, ctx);
    return sendWrite(ctx, async () =>
      wallets.client.writeContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "fund",
        args: [jobId, EMPTY_OPT_PARAMS],
      }),
    );
  }

  /** fund 靠 safeTransferFrom 拉款，调用前必须先对 Job 合约 approve。 */
  async function approveUsdc(amount: bigint, ctx: WriteContext): Promise<void> {
    const owner = wallets.client.account.address;
    try {
      const allowance = await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, jobContract],
      });
      if (allowance >= amount) {
        return;
      }
      const txHash = await wallets.client.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [jobContract, amount],
      });
      await waitForSuccess(txHash, { ...ctx, action: "fund" });
    } catch (error: unknown) {
      if (error instanceof ChainError) throw error;
      throw wrapChainError(error, "USDC approve 失败", {
        action: "fund",
        ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId }),
        idempotencyKey: ctx.key,
      });
    }
  }

  async function submit(jobId: bigint, deliverableHash: Hex): Promise<Hex> {
    const ctx: WriteContext = { action: "submit", key: idempotencyKey(jobId, "submit"), jobId };
    return sendWrite(ctx, async () =>
      wallets.provider.writeContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "submit",
        args: [jobId, deliverableHash, EMPTY_OPT_PARAMS],
      }),
    );
  }

  async function complete(jobId: bigint, reasonHash: Hex): Promise<Hex> {
    const ctx: WriteContext = { action: "complete", key: idempotencyKey(jobId, "complete"), jobId };
    const existing = await lookupTxHash(ctx.key);
    if (existing !== null) {
      return existing;
    }
    // §2.3：complete 仅 Submitted 态、仅 evaluator。
    assertState((await readJob(jobId, "complete")).status, ["submitted"], ctx);
    return sendWrite(ctx, async () =>
      wallets.evaluator.writeContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "complete",
        args: [jobId, reasonHash, EMPTY_OPT_PARAMS],
      }),
    );
  }

  async function reject(jobId: bigint, reasonHash: Hex): Promise<Hex> {
    const ctx: WriteContext = { action: "reject", key: idempotencyKey(jobId, "reject"), jobId };
    const existing = await lookupTxHash(ctx.key);
    if (existing !== null) {
      return existing;
    }
    // §2.3：evaluator 在 Funded（提交前拒绝）与 Submitted 两态都可 reject，全额退客户。
    assertState((await readJob(jobId, "reject")).status, ["funded", "submitted"], ctx);
    return sendWrite(ctx, async () =>
      wallets.evaluator.writeContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "reject",
        args: [jobId, reasonHash, EMPTY_OPT_PARAMS],
      }),
    );
  }

  async function claimRefund(jobId: bigint): Promise<Hex> {
    const ctx: WriteContext = {
      action: "claimRefund",
      key: idempotencyKey(jobId, "claimRefund"),
      jobId,
    };
    const existing = await lookupTxHash(ctx.key);
    if (existing !== null) {
      return existing;
    }
    const job = await readJob(jobId, "claimRefund");
    assertState(job.status, ["funded", "submitted"], ctx);
    const block = await publicClient.getBlock({ blockTag: "latest" });
    if (block.timestamp < job.expiredAt) {
      throw new ChainError(
        `claimRefund 尚未到期：链上时间 ${block.timestamp.toString()} < ` +
          `expiredAt ${job.expiredAt.toString()}`,
        { action: "claimRefund", jobId, idempotencyKey: ctx.key },
      );
    }
    // 链上无 msg.sender 检查（permissionless），我方仍固定由 client 角色调用。
    return sendWrite(ctx, async () =>
      wallets.client.writeContract({
        address: jobContract,
        abi: agenticCommerceAbi,
        functionName: "claimRefund",
        args: [jobId],
      }),
    );
  }

  async function getFeeRates(): Promise<JobFeeRates> {
    try {
      const [platformFeeBP, evaluatorFeeBP] = await Promise.all([
        publicClient.readContract({
          address: jobContract,
          abi: agenticCommerceAbi,
          functionName: "platformFeeBP",
        }),
        publicClient.readContract({
          address: jobContract,
          abi: agenticCommerceAbi,
          functionName: "evaluatorFeeBP",
        }),
      ]);
      return { platformFeeBP, evaluatorFeeBP };
    } catch (error: unknown) {
      throw wrapChainError(error, "读取链上费率失败（账本不许硬编码费率）");
    }
  }

  return {
    createJob,
    setBudget,
    fund,
    submit,
    complete,
    reject,
    claimRefund,
    getJob: async (jobId: bigint) => readJob(jobId, "createJob"),
    getJobState: async (jobId: bigint) => (await readJob(jobId, "createJob")).status,
    getFeeRates,
  };
}

/**
 * 按合约 §2.4 算净额分账。费率必须来自 {@link JobClient.getFeeRates}，不许硬编码。
 *
 * @param budget - `job.budget`（名义案件费）
 * @param fees - 链上读到的费率
 * @returns provider 实收 `net`、平台费、验证器费
 */
export function splitFees(
  budget: bigint,
  fees: JobFeeRates,
): { readonly platformFee: bigint; readonly evaluatorFee: bigint; readonly net: bigint } {
  const platformFee = (budget * fees.platformFeeBP) / 10_000n;
  const evaluatorFee = (budget * fees.evaluatorFeeBP) / 10_000n;
  return { platformFee, evaluatorFee, net: budget - platformFee - evaluatorFee };
}
