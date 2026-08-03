/**
 * 演示 UI 的后端小口子：**帮浏览器编码交易 + 替 provider 走 setBudget**。
 *
 * 设计边界（与主服务共用一份纪律）：
 *
 * - **私钥永远只在两端各自手里**。浏览器钱包签它自己的三笔（createJob / approve /
 *   fund），我们只签 provider 必须签的那一笔（setBudget，链上限定 provider）。
 *   encode 端点只产 calldata，不碰任何签名。
 * - **金额与角色不受调用方控制**。createJob 的 provider/evaluator、approve 与
 *   setBudget 的金额全部由服务端配置填死——调用方能选的只有过期时刻和 jobId。
 * - 这是演示设施，**不进 agent card**：它不是对外承诺的能力面。
 *
 * 已知限制（testnet 演示范围，engine 侧同样注明）：不验证调用方就是 Job 的
 * client。setBudget 的滥用面有限——金额恒为 caseBudget，且只对我们是 provider
 * 的 Job 有效；最坏结果是替人付一笔 setBudget 的 gas。
 */

import { agenticCommerceAbi, idempotencyKey } from "@citely/chain";
import type { ChainAction, IdempotencyStore, JobClient, JobState } from "@citely/chain/types";
import { usdc6ToAtomicString } from "@citely/engine";
import type { Usdc6 } from "@citely/engine";
import { encodeFunctionData, erc20Abi, getAbiItem, toEventSelector, zeroAddress } from "viem";
import type { AbiEvent, Address, Hex } from "viem";

/** 链上 `expiredAt` 下限 5 分钟 + 余量（与 chain 包 `expiryFromNow` 的口径一致）。 */
const MIN_EXPIRY_SECONDS = 330;

/** 演示建的 Job 统一用这句描述——它会上链，写清来源。 */
const DEMO_JOB_DESCRIPTION = "Citely Deal Desk case (web demo)";

/**
 * `JobCreated` 的 topic0。前端靠它从 receipt 里认出事件、从 topics[1] 读 jobId。
 * **从 ABI 派生而不是手写签名串**：ABI 是照录合约的唯一事实源，手抄一遍签名
 * 等于造第二份可能漂移的事实。
 */
const JOB_CREATED_TOPIC = toEventSelector(
  getAbiItem({ abi: agenticCommerceAbi, name: "JobCreated" }) as AbiEvent,
);

/**
 * `jobStatus` 的内存缓存存活时长。
 *
 * 一个**无鉴权的 GET 不能变成 RPC 放大器**——公共 Arc RPC 限流是本仓库实测过的坑，
 * 演示当场被限流比少显示一行状态严重得多。10 秒对"看一眼这个 Job 现在什么状态"
 * 完全够用，链上确认本来也要好几秒。
 */
const JOB_STATUS_TTL_MS = 10_000;

/** 缓存条目上限：演示页面的 jobId 基数极小，200 条已经远超需要。 */
const JOB_STATUS_CACHE_MAX = 200;

/** `JobStatusView.tx` 的可写形态（构造期用，对外仍是只读接口）。 */
interface MutableJobTx {
  set_budget?: Hex;
  submit?: Hex;
  complete?: Hex;
  reject?: Hex;
}

/**
 * 对外字段名 → 链上动作名。
 *
 * 键**必须**用 chain 导出的 `idempotencyKey(jobId, action)` 构造：
 * server 自己拼 `${jobId}:submit` 等于造第二份会漂移的事实。
 */
const JOB_TX_FIELDS: readonly (readonly [keyof MutableJobTx, ChainAction])[] = [
  ["set_budget", "setBudget"],
  ["submit", "submit"],
  ["complete", "complete"],
  ["reject", "reject"],
];

/**
 * 链上 Job 的对外只读视图。
 *
 * 全部字段都是**已经公开**的信息（链上可读 / 已在 `/app/api/config` 里），
 * 金额与时间一律十进制字符串——bigint 进不了 JSON。
 */
export interface JobStatusView {
  /** 十进制字符串。 */
  readonly job_id: string;
  readonly status: JobState;
  readonly client: Address;
  readonly provider: Address;
  readonly evaluator: Address;
  /** 6 位小数原子单位。 */
  readonly budget_atomic: string;
  /** Unix 秒，十进制字符串。 */
  readonly expired_at: string;
  /** 服务端**自己发过**的那几笔交易（从 tx_log 读；没发过就没有该键）。 */
  readonly tx: {
    readonly set_budget?: Hex;
    readonly submit?: Hex;
    readonly complete?: Hex;
    readonly reject?: Hex;
  };
}

export interface DemoApiConfig {
  readonly chainId: number;
  readonly jobContract: Address;
  readonly usdc: Address;
  /** 8183 provider（运营地址）。 */
  readonly provider: Address;
  /** 8183 evaluator（验证器地址）。 */
  readonly evaluator: Address;
  readonly caseBudget: Usdc6;
}

/** 浏览器直接塞进 `eth_sendTransaction` 的最小载荷。 */
export interface EncodedTx {
  readonly to: Address;
  readonly data: Hex;
}

/** 演示端点的业务失败：带 HTTP 状态码，路由层原样映射，不猜。 */
export class DemoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DemoApiError";
  }
}

export interface DemoApi {
  /** 建单页要的全部公开常量（无密钥、无内部地址）。 */
  readonly publicConfig: () => Record<string, unknown>;
  readonly encode: (action: unknown, params: unknown) => EncodedTx;
  /** provider 侧的握手一步：校验后 setBudget（tx_log 幂等，重调不重发）。 */
  readonly setBudget: (jobId: bigint) => Promise<{ readonly txHash: Hex }>;
  /**
   * 只读：链上 Job 视图 + 服务端已发过的那几笔 tx。
   * Job 不存在（client 归零）抛 `DemoApiError(404)`。
   */
  readonly jobStatus: (jobId: bigint) => Promise<JobStatusView>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimalBigint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    throw new DemoApiError(400, `${field} must be a decimal string.`);
  }
  return BigInt(value);
}

/**
 * 构造演示 API。
 *
 * @param deps - 已接好幂等存储的 jobClient 与公开配置
 * @returns 三个纯函数口子，路由层直接挂
 */
export function createDemoApi(deps: {
  readonly jobClient: JobClient;
  /** 读 setBudget/submit/complete/reject 的 txHash。**只 lookup，不写**。 */
  readonly txLog: IdempotencyStore;
  readonly config: DemoApiConfig;
  /** 缓存用的时钟，测试注入假时钟。默认 `Date.now`。 */
  readonly nowMs?: () => number;
}): DemoApi {
  const { jobClient, txLog, config } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());
  /** jobId → 成功结果。**只缓存成功**：失败缓存会把一次抖动变成十秒不可用。 */
  const jobStatusCache = new Map<string, { readonly at: number; readonly view: JobStatusView }>();

  function encodeCreateJob(params: Record<string, unknown>): EncodedTx {
    const expiredAt = decimalBigint(params["expired_at"], "expired_at");
    return {
      to: config.jobContract,
      data: encodeFunctionData({
        abi: agenticCommerceAbi,
        functionName: "createJob",
        // provider/evaluator/description 服务端填死：调用方编不出一个角色错误的 Job。
        args: [config.provider, config.evaluator, expiredAt, DEMO_JOB_DESCRIPTION, zeroAddress],
      }),
    };
  }

  function encodeApprove(): EncodedTx {
    return {
      to: config.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        // 金额恒为 caseBudget：授权面最小化，approve 多少 fund 就拉多少。
        // Usdc6 是 branded bigint，反方向直接当 bigint 用是安全的。
        args: [config.jobContract, config.caseBudget],
      }),
    };
  }

  function encodeFund(params: Record<string, unknown>): EncodedTx {
    const jobId = decimalBigint(params["job_id"], "job_id");
    return {
      to: config.jobContract,
      data: encodeFunctionData({
        abi: agenticCommerceAbi,
        functionName: "fund",
        args: [jobId, "0x"],
      }),
    };
  }

  return {
    publicConfig: () => ({
      chain_id: config.chainId,
      job_contract: config.jobContract,
      usdc: config.usdc,
      provider: config.provider,
      evaluator: config.evaluator,
      case_budget_atomic: usdc6ToAtomicString(config.caseBudget),
      min_expiry_seconds: MIN_EXPIRY_SECONDS,
      job_created_topic: JOB_CREATED_TOPIC,
      arcscan_base: "https://testnet.arcscan.app",
    }),

    encode: (action, params) => {
      const p = isRecord(params) ? params : {};
      switch (action) {
        case "createJob":
          return encodeCreateJob(p);
        case "approve":
          return encodeApprove();
        case "fund":
          return encodeFund(p);
        default:
          throw new DemoApiError(400, "action must be one of: createJob | approve | fund");
      }
    },

    setBudget: async (jobId) => {
      const job = await jobClient.getJob(jobId);
      // 8183 的 jobs mapping 对不存在的 id 返回零值 struct——用 client 归零判"不存在"。
      if (job.client === zeroAddress) {
        throw new DemoApiError(404, `job ${jobId.toString()} not found on-chain`);
      }
      if (job.provider.toLowerCase() !== config.provider.toLowerCase()) {
        throw new DemoApiError(409, `job ${jobId.toString()} provider is not this deployment`);
      }
      if (job.status !== "open") {
        throw new DemoApiError(
          409,
          `job ${jobId.toString()} is "${job.status}", setBudget requires "open"`,
        );
      }
      // tx_log key 就是 `${jobId}:setBudget`（chain 包既有实现）——重调幂等，不重发。
      const txHash = await jobClient.setBudget(jobId, config.caseBudget);
      return { txHash };
    },

    jobStatus: async (jobId) => {
      const key = jobId.toString();
      const cached = jobStatusCache.get(key);
      if (cached !== undefined && nowMs() - cached.at < JOB_STATUS_TTL_MS) {
        return cached.view;
      }
      const job = await jobClient.getJob(jobId);
      // 与 setBudget 同一判据：8183 的 jobs mapping 对不存在的 id 返回零值 struct。
      if (job.client === zeroAddress) {
        throw new DemoApiError(404, `job ${key} not found on-chain`);
      }
      const tx: MutableJobTx = {};
      for (const [field, action] of JOB_TX_FIELDS) {
        const record = await txLog.lookup(idempotencyKey(jobId, action));
        // 没发过就没有该键——**空键是诚实的，占位的假 hash 不是**。
        if (record !== null) tx[field] = record.txHash;
      }
      const view: JobStatusView = {
        job_id: key,
        status: job.status,
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        budget_atomic: job.budget.toString(),
        expired_at: job.expiredAt.toString(),
        tx,
      };
      jobStatusCache.delete(key);
      if (jobStatusCache.size >= JOB_STATUS_CACHE_MAX) {
        // Map 迭代是插入序，第一个就是最旧的那条。
        const oldest = jobStatusCache.keys().next();
        if (oldest.done !== true) jobStatusCache.delete(oldest.value);
      }
      jobStatusCache.set(key, { at: nowMs(), view });
      return view;
    },
  };
}
