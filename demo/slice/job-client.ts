/**
 * 按运行模式选用 8183 客户端。
 *
 * 这段逻辑从 `run-vertical-slice.ts` 抽出来，是因为它承载一条**必须可测**的纪律：
 * **`--dry-run` 绝不发链上交易**。
 *
 * 这条纪律以前"显然成立"，因为 dry-run 下 `jobContract` 恒为 `null`，
 * 想构造真 client 也没有地址。自从 dry-run 改成**携带合约地址**（为了真读费率
 * view），这个天然屏障就没了——现在只剩 `config.dryRun` 这一个判断挡着。
 * 屏障从"结构上不可能"退化成"一个 if 写对了"，那就必须有测试盯着。
 */

import {
  ARC_TESTNET,
  createArcPublicClient,
  createArcTransport,
  createChainClients,
  createJobClient,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from "@citely/chain";
import type { JobClient, JobFeeRates } from "@citely/chain";
import { createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { SliceAddresses, SliceConfig } from "./config.js";
import { createDryRunJobClient } from "./doubles.js";

/** `.env.example` 里的 Arc Testnet RPC 默认值（合约 §8）。 */
const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";
const DEFAULT_ARC_RPC_FALLBACK = "https://arc-testnet.drpc.org";

/** 选用的客户端种类。导出是为了让测试能直接断言选的是哪条分支。 */
export type ChainMode = "dry-run-double" | "real-client";

/**
 * 判定该用哪种客户端。
 *
 * 刻意做成**只看 `dryRun` 一个字段**的纯函数：判定条件一旦掺进
 * "有没有地址""能不能连上"之类的东西，就会出现"本该排练却真发了交易"的缝。
 *
 * @param config - 运行配置
 * @returns 客户端种类
 */
export function selectChainMode(config: Pick<SliceConfig, "dryRun">): ChainMode {
  return config.dryRun ? "dry-run-double" : "real-client";
}

/**
 * 建 8183 客户端。
 *
 * @param config - 运行配置
 * @param addresses - 四个角色地址
 * @param fees - 链上读回的费率（替身照此回吐，不自带费率常量）
 * @returns dry-run 下是内存替身，真实模式下是 chain 的实现
 * @throws {Error} 真实模式缺合约地址
 */
export function buildJobClient(
  config: SliceConfig,
  addresses: SliceAddresses,
  fees: JobFeeRates,
  /**
   * 幂等存储。**必须传持久化实现**（engine 的 `SqliteIdempotencyStore`），
   * 否则"重跑不重发交易"只在单个进程内成立——跨进程重跑时链上会被重复写。
   * 不传则退回进程内存实现，仅供不关心跨进程幂等的单测使用。
   */
  store: IdempotencyStore = new InMemoryIdempotencyStore(),
): JobClient {
  if (selectChainMode(config) === "dry-run-double") {
    return createDryRunJobClient({
      client: addresses.marketplace,
      provider: addresses.operator,
      evaluator: addresses.verifier,
      fees,
    }).client;
  }

  if (config.jobContract === null || config.usdc === null) {
    throw new Error("real run requires JOB_CONTRACT_ADDRESS and USDC_ADDRESS");
  }
  const rpc = {
    primaryUrl: config.rpcUrl ?? DEFAULT_ARC_RPC_URL,
    ...(config.rpcUrl === null ? {} : { fallbackUrl: DEFAULT_ARC_RPC_FALLBACK }),
  };
  return createJobClient({
    jobContract: config.jobContract,
    usdc: config.usdc,
    publicClient: createArcPublicClient(rpc),
    wallets: {
      // 8183 client 角色用客户钱包。chain 的 `WalletRole` 目前只有
      // operator/verifier/procurement 三档，没有 client 档（合约 §2.1 要求有），
      // 所以这一把直接用 chain 的 transport/chain 常量自行构造，
      // **不借用别的角色名**——角色名会被审查按"谁动了客户的钱"来 grep。
      client: createWalletClient({
        account: privateKeyToAccount(config.keys.marketplace),
        chain: ARC_TESTNET,
        transport: createArcTransport(rpc),
      }),
      provider: createChainClients("operator", config.keys.operator, rpc).walletClient,
      evaluator: createChainClients("verifier", config.keys.verifier, rpc).walletClient,
    },
    store,
  });
}
