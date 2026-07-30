import { ENV_KEYS, readPrivateKey, type EnvSource } from "./config/env.js";
import type { JobRoleWallets } from "./job-client.js";
import { createChainClients, type ChainClients, type RpcConfig } from "./wallet.js";

/**
 * 8183 三个角色各自独立的一组 client（§2.1）。
 *
 * 三把私钥物理分离，因此**三组 client 也各自独立**，不共用 walletClient。
 */
export interface JobRoleClients {
  /** 8183 `client`：MARKETPLACE_PRIVATE_KEY */
  readonly client: ChainClients;
  /** 8183 `provider`：OPERATOR_PRIVATE_KEY */
  readonly provider: ChainClients;
  /** 8183 `evaluator`：VERIFIER_PRIVATE_KEY */
  readonly evaluator: ChainClients;
}

/**
 * 从环境变量装配 8183 三角色 client。
 *
 * 抽出来是因为每个 spike / 端到端脚本都要装同一套，抄三遍迟早抄错一把密钥——
 * 而"用错角色的钱包"这类错误只会在链上 revert 时才暴露。
 *
 * @param env - 环境变量来源
 * @param rpc - 主/备 RPC
 */
export function createJobRoleClients(env: EnvSource, rpc: RpcConfig): JobRoleClients {
  return {
    client: createChainClients("marketplace", readPrivateKey(env, ENV_KEYS.marketplaceKey), rpc),
    provider: createChainClients("operator", readPrivateKey(env, ENV_KEYS.operatorKey), rpc),
    evaluator: createChainClients("verifier", readPrivateKey(env, ENV_KEYS.verifierKey), rpc),
  };
}

/** 取出 {@link JobRoleWallets}，喂给 `createJobClient`。 */
export function toJobRoleWallets(clients: JobRoleClients): JobRoleWallets {
  return {
    client: clients.client.walletClient,
    provider: clients.provider.walletClient,
    evaluator: clients.evaluator.walletClient,
  };
}
