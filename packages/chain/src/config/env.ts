import { existsSync } from "node:fs";

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { ChainError } from "../errors.js";
import { assertPrivateKey, type RpcConfig } from "../wallet.js";
import { registerSecret, safeErrorMessage } from "./redact.js";

/**
 * 环境变量来源。默认 `process.env`，测试注入普通对象即可（零私钥零网络）。
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** `.env.example` 是唯一事实源；这里的变量名必须与它逐字一致。 */
export const ENV_KEYS = {
  chainId: "ARC_CHAIN_ID",
  rpcUrl: "ARC_RPC_URL",
  rpcUrlFallback: "ARC_RPC_URL_FALLBACK",
  operatorKey: "OPERATOR_PRIVATE_KEY",
  verifierKey: "VERIFIER_PRIVATE_KEY",
  marketplaceKey: "MARKETPLACE_PRIVATE_KEY",
  procurementKey: "PROCUREMENT_PRIVATE_KEY",
  moduleAttesterKey: "MODULE_ATTESTER_PRIVATE_KEY",
  jobContract: "JOB_CONTRACT_ADDRESS",
  usdc: "USDC_ADDRESS",
  gatewayWallet: "GATEWAY_WALLET_ADDRESS",
  pollIntervalMs: "CHAIN_POLL_INTERVAL_MS",
  msbAgentBaseUrl: "MSB_AGENT_BASE_URL",
  facilitatorUrl: "X402_FACILITATOR_URL",
  openaiApiKey: "OPENAI_API_KEY",
  openaiModel: "OPENAI_MODEL",
} as const;

/** Arc Testnet 的 chainId，`ARC_CHAIN_ID` 必须与之一致。 */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** 轮询间隔缺省值（毫秒），与合约 §3「轮询不订阅」的默认 5s 一致。 */
export const DEFAULT_CHAIN_POLL_INTERVAL_MS = 5_000;

/** 五把链上/离线密钥，按角色分列。三密钥物理分离，任何情况下不得互相复用。 */
export interface ChainKeys {
  /** 8183 provider：setBudget / submit */
  readonly operator: Hex;
  /** 8183 evaluator：complete / reject */
  readonly verifier: Hex;
  /** 8183 client：createJob / approve+fund / claimRefund */
  readonly marketplace: Hex;
  /** 链下 x402 付款，不参与 8183 */
  readonly procurement: Hex;
  /** 离线签 Module 版本认证清单，只在 scripts 用 */
  readonly moduleAttester: Hex;
}

/** 链上合约地址。 */
export interface ChainAddresses {
  readonly jobContract: Address;
  readonly usdc: Address;
  /** Circle Gateway Wallet：EIP-3009 的 verifyingContract，**不是** USDC 合约。 */
  readonly gatewayWallet: Address;
}

/** 全量环境配置。缺任何一项都会在加载时抛出指名道姓的 {@link ChainError}。 */
export interface ChainEnv {
  readonly chainId: number;
  readonly rpc: RpcConfig;
  readonly keys: ChainKeys;
  readonly addresses: ChainAddresses;
  readonly pollIntervalMs: number;
  readonly msbAgentBaseUrl: string;
  readonly facilitatorUrl: string;
}

function missing(name: string, hint: string): ChainError {
  return new ChainError(`环境变量 ${name} 缺失或为空：${hint}（模板见仓库根 .env.example）`);
}

/**
 * 读一个必填的非空字符串环境变量。
 *
 * @param env - 环境变量来源
 * @param name - 变量名
 * @param hint - 出错时告诉用户该填什么
 */
export function requireEnv(env: EnvSource, name: string, hint: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw missing(name, hint);
  }
  return value;
}

/** 读一个可选环境变量，空串按未设置处理。 */
export function optionalEnv(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * 读一把私钥：校验 `^0x[0-9a-fA-F]{64}$` 并登记进脱敏表。
 *
 * 登记后所有 {@link redactSecrets} 调用都会自动屏蔽它——脱敏不能靠每个 catch 自觉传参。
 */
export function readPrivateKey(env: EnvSource, name: string): Hex {
  const key = assertPrivateKey(env[name], name);
  registerSecret(key);
  registerSecret(key.slice(2));
  return key;
}

/** 读一个合约地址并转成 EIP-55 校验和形式。 */
export function readAddress(env: EnvSource, name: string, hint: string): Address {
  const raw = requireEnv(env, name, hint);
  if (!isAddress(raw, { strict: false })) {
    throw new ChainError(`环境变量 ${name} 不是合法的 EVM 地址：${raw}`);
  }
  return getAddress(raw);
}

/** 读一个正整数环境变量，未设置时用 `fallback`。 */
export function readPositiveInt(env: EnvSource, name: string, fallback: number): number {
  const raw = optionalEnv(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ChainError(`环境变量 ${name} 必须是正整数：${raw}`);
  }
  return Number(raw);
}

/** 读一个 HTTPS URL（本地开发允许 http://localhost）。 */
export function readUrl(env: EnvSource, name: string, hint: string): string {
  const raw = requireEnv(env, name, hint);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    throw new ChainError(`环境变量 ${name} 不是合法 URL：${raw}`, {}, { cause: error });
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ChainError(`环境变量 ${name} 必须使用 HTTPS：${raw}`);
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * OpenAI 模型 ID 是否带日期 snapshot（形如 `gpt-5.6-luna-2026-05-13`）。
 *
 * 别名会随时间漂移，漂移即 golden cache 静默失效——doctor 用它把别名判为 ❌。
 *
 * @param model - `OPENAI_MODEL` 的值
 */
export function isDatedModelSnapshot(model: string): boolean {
  return /-\d{4}-\d{2}-\d{2}$/.test(model.trim());
}

function readKeys(env: EnvSource): ChainKeys {
  return {
    operator: readPrivateKey(env, ENV_KEYS.operatorKey),
    verifier: readPrivateKey(env, ENV_KEYS.verifierKey),
    marketplace: readPrivateKey(env, ENV_KEYS.marketplaceKey),
    procurement: readPrivateKey(env, ENV_KEYS.procurementKey),
    moduleAttester: readPrivateKey(env, ENV_KEYS.moduleAttesterKey),
  };
}

function readAddresses(env: EnvSource): ChainAddresses {
  return {
    jobContract: readAddress(env, ENV_KEYS.jobContract, "ERC-8183 参考合约地址，spike ① 回填"),
    usdc: readAddress(env, ENV_KEYS.usdc, "Arc Testnet USDC，即 8183 的 paymentToken"),
    gatewayWallet: readAddress(env, ENV_KEYS.gatewayWallet, "Circle Gateway Wallet 合约地址"),
  };
}

function readRpc(env: EnvSource): RpcConfig {
  const fallbackUrl = optionalEnv(env, ENV_KEYS.rpcUrlFallback);
  const primaryUrl = readUrl(env, ENV_KEYS.rpcUrl, "Arc Testnet RPC 地址");
  // exactOptionalPropertyTypes：没有备用 RPC 时不能把 undefined 显式塞进字段。
  return fallbackUrl === undefined ? { primaryUrl } : { primaryUrl, fallbackUrl };
}

function readChainId(env: EnvSource): number {
  const chainId = readPositiveInt(env, ENV_KEYS.chainId, ARC_TESTNET_CHAIN_ID);
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new ChainError(
      `环境变量 ${ENV_KEYS.chainId}=${String(chainId)} 与 Arc Testnet ` +
        `(${String(ARC_TESTNET_CHAIN_ID)}) 不一致：本项目只用 testnet`,
    );
  }
  return chainId;
}

/**
 * 加载全量链上配置。任何一项缺失/格式非法都会抛出指名道姓的 {@link ChainError}，
 * 消息里绝不回显私钥值。
 *
 * @param env - 环境变量来源，默认 `process.env`
 */
export function loadChainEnv(env: EnvSource = process.env): ChainEnv {
  return {
    chainId: readChainId(env),
    rpc: readRpc(env),
    keys: readKeys(env),
    addresses: readAddresses(env),
    pollIntervalMs: readPositiveInt(env, ENV_KEYS.pollIntervalMs, DEFAULT_CHAIN_POLL_INTERVAL_MS),
    msbAgentBaseUrl: readUrl(env, ENV_KEYS.msbAgentBaseUrl, "msb-agent 线上地址"),
    facilitatorUrl: readUrl(env, ENV_KEYS.facilitatorUrl, "Circle x402 facilitator 地址"),
  };
}

/**
 * 若 `path` 存在则把它加载进 `process.env`（Node 内建 `loadEnvFile`，零依赖）。
 *
 * 脚本入口用；`.env` 不入库，缺失时静默跳过——真正的报错留给
 * {@link loadChainEnv}，那里能指出到底缺哪个变量。
 *
 * @param path - `.env` 路径
 * @returns 是否实际加载了文件
 */
export function loadDotEnvFile(path: string): boolean {
  if (!existsSync(path) || typeof process.loadEnvFile !== "function") {
    return false;
  }
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error: unknown) {
    // .env 存在却读不了是配置问题，不能静默——但也不能带出文件内容。
    throw new ChainError(`.env 加载失败（${path}）：${safeErrorMessage(error)}`, {}, { cause: error });
  }
}
