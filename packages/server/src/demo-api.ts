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

import { agenticCommerceAbi } from "@citely/chain";
import type { JobClient } from "@citely/chain/types";
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
  readonly config: DemoApiConfig;
}): DemoApi {
  const { jobClient, config } = deps;

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
  };
}
