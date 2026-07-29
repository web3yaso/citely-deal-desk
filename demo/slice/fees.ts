/**
 * 链上手续费率的读取（合约 §2.4）。
 *
 * **`--dry-run` 也真读链上费率**：`platformFeeBP()` / `evaluatorFeeBP()` 是
 * `view`，只读、不花钱、不发交易，完全符合"不发链上交易、不付费"的语义。
 *
 * 为什么非要真读——演示里印一行"费率读链上 view"却配上编造的数字，是**最坏**的一种
 * 假：评委只要去链上核一次就会发现对不上，然后有理由怀疑整个账本对账都是编的。
 * 要么真读，要么如实标注是占位值，没有第三条路。
 *
 * 读不到时（没配 `JOB_CONTRACT_ADDRESS`、或网络不通）不静默填 0——
 * 0 是一个**看起来完全正常**的费率，静默填 0 就是在说谎。返回的 `source`
 * 会明说这是占位值，调用方据它改标签。
 */

import { agenticCommerceAbi, createArcPublicClient } from "@citely/chain";
import type { JobFeeRates } from "@citely/chain";
import type { Address } from "viem";

/**
 * 备用 RPC 排在**前面**：公共 `rpc.testnet.arc.network` 连读几个 view 就会被限流
 * （主导实测连读五个 view 后三个被拒）。费率是演示必读项，不值得赌主 RPC 的额度。
 */
const FEE_READ_RPC = {
  primaryUrl: "https://arc-testnet.drpc.org",
  fallbackUrl: "https://rpc.testnet.arc.network",
} as const;

/** 费率及其来源。`source` 是给人看的，必须诚实。 */
export interface ResolvedFees {
  readonly fees: JobFeeRates;
  /** 供打印的来源说明。 */
  readonly source: string;
  /** 是否真的来自链上。false 表示是占位值。 */
  readonly fromChain: boolean;
}

/** 读不到链上费率时用的占位值。**只在明确标注为占位时使用**。 */
const PLACEHOLDER_FEES: JobFeeRates = { platformFeeBP: 0n, evaluatorFeeBP: 0n };

/**
 * 读取链上费率。
 *
 * @param jobContract - 8183 合约地址；`null` 表示未配置
 * @returns 费率与来源说明；读不到时返回明确标注的占位值
 */
export async function resolveFeeRates(jobContract: Address | null): Promise<ResolvedFees> {
  if (jobContract === null) {
    return {
      fees: PLACEHOLDER_FEES,
      source: "演示占位值（未配置 JOB_CONTRACT_ADDRESS，未能读取链上费率）",
      fromChain: false,
    };
  }
  const publicClient = createArcPublicClient(FEE_READ_RPC);
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
    return {
      fees: { platformFeeBP, evaluatorFeeBP },
      source: `链上 view @ ${jobContract}`,
      fromChain: true,
    };
  } catch (err) {
    // 不吞错，但也不让"读费率失败"把整个 dry-run 排练打断：如实降级成占位值，
    // 标签会说清楚。真链模式下费率读不到会在 JobClient.getFeeRates() 那里响亮失败。
    return {
      fees: PLACEHOLDER_FEES,
      source: `演示占位值（读取链上费率失败：${err instanceof Error ? err.name : "unknown"}）`,
      fromChain: false,
    };
  }
}
