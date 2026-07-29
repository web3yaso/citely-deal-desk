/**
 * 纵切演示脚本的运行配置。
 *
 * 两种模式，**互斥且显式**：
 * - `--dry-run`：不发链上交易、不付费。缺 `.env` 时用**当场生成的一次性演示密钥**，
 *   并打横幅告知——源码里没有任何私钥字面量，生成的密钥进程退出即消失；
 * - 真实模式：四把密钥与合约地址一个都不能少，缺一个就响亮报错中止。
 *   绝不"缺了就自动降级成 dry-run"——那正是演示现场最危险的失败方式。
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/** 配置缺失或自相矛盾。 */
export class SliceConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SliceConfigError";
  }
}

/** 演示需要的四把链上/离线密钥（按合约 §2.1 的角色映射）。 */
export interface SliceKeys {
  /** 8183 client：createJob / approve+fund。 */
  readonly marketplace: Hex;
  /** 8183 provider：setBudget / submit；**也是 SA 的签名者**（合约 §5.1）。 */
  readonly operator: Hex;
  /** 8183 evaluator：complete / reject。 */
  readonly verifier: Hex;
  /** x402 采购钱包，不参与 8183。 */
  readonly procurement: Hex;
}

export interface SliceConfig {
  readonly dryRun: boolean;
  /** dry-run 且未配置 `.env` 时为 true——横幅据它提示"这些密钥是一次性的"。 */
  readonly ephemeralKeys: boolean;
  readonly keys: SliceKeys;
  readonly chainId: number;
  /**
   * 8183 合约地址。真实模式必需；**dry-run 下有就读、没有就是 `null`**——
   * dry-run 也要真读链上费率（`platformFeeBP()` 是 view，只读不花钱），
   * 所以这里不能像早先那样在 dry-run 下一律置空。
   */
  readonly jobContract: Address | null;
  readonly usdc: Address | null;
  readonly rpcUrl: string | null;
  readonly msbAgentBaseUrl: string;
  readonly adjudicatorMode: string;
}

/** `.env.example` 里默认的 msb-agent 基址（合约 §1）。 */
const DEFAULT_MSB_AGENT_BASE_URL = "https://msb-agent-production-769d.up.railway.app";

const PRIVATE_KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/** 环境变量来源。注入是为了让配置解析可单测。 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * 读取一把必需的私钥。
 *
 * @param env - 环境变量来源
 * @param name - 变量名
 * @returns 已校验形状的私钥
 * @throws {SliceConfigError} 缺失或形状非法（消息里只有变量名与长度，没有值）
 */
function requireKey(env: EnvSource, name: string): Hex {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    throw new SliceConfigError(`${name} is not set (cp .env.example .env and fill it)`);
  }
  if (!PRIVATE_KEY_SHAPE.test(raw)) {
    throw new SliceConfigError(
      `${name} must be 0x-prefixed 32-byte hex (got ${String(raw.length)} chars)`,
    );
  }
  return raw as Hex;
}

/**
 * 读取一个必需的地址。
 *
 * @param env - 环境变量来源
 * @param name - 变量名
 * @returns 校验过的地址
 * @throws {SliceConfigError} 缺失或形状非法
 */
function requireAddress(env: EnvSource, name: string): Address {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    throw new SliceConfigError(`${name} is not set (cp .env.example .env and fill it)`);
  }
  if (!ADDRESS_SHAPE.test(raw)) {
    throw new SliceConfigError(`${name} must be a 20-byte hex address`);
  }
  return raw as Address;
}

/**
 * 读取一个可选地址。缺失返回 `null`，形状非法仍然抛错——
 * "没配"和"配错了"是两回事，后者必须响亮失败。
 *
 * @param env - 环境变量来源
 * @param name - 变量名
 * @returns 地址；未配置时为 `null`
 * @throws {SliceConfigError} 配了但形状非法
 */
function optionalAddress(env: EnvSource, name: string): Address | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  if (!ADDRESS_SHAPE.test(raw)) {
    throw new SliceConfigError(`${name} must be a 20-byte hex address`);
  }
  return raw as Address;
}

/** 四把当场生成的一次性演示密钥。仅 dry-run 用，进程退出即消失。 */
function ephemeralKeys(): SliceKeys {
  return {
    marketplace: generatePrivateKey(),
    operator: generatePrivateKey(),
    verifier: generatePrivateKey(),
    procurement: generatePrivateKey(),
  };
}

/**
 * 判断 `.env` 是否至少配了链上密钥。
 *
 * @param env - 环境变量来源
 * @returns 四把密钥是否都存在
 */
function hasAllKeys(env: EnvSource): boolean {
  return (
    ["MARKETPLACE_PRIVATE_KEY", "OPERATOR_PRIVATE_KEY", "VERIFIER_PRIVATE_KEY", "PROCUREMENT_PRIVATE_KEY"] as const
  ).every((name) => {
    const raw = env[name];
    return raw !== undefined && raw !== "";
  });
}

/**
 * 解析命令行与环境，产出运行配置。
 *
 * @param argv - 命令行参数（通常是 `process.argv.slice(2)`）
 * @param env - 环境变量来源
 * @returns 运行配置
 * @throws {SliceConfigError} 真实模式下缺密钥或缺合约地址
 */
export function resolveSliceConfig(argv: readonly string[], env: EnvSource): SliceConfig {
  const dryRun = argv.includes("--dry-run");
  const chainId = Number(env["ARC_CHAIN_ID"] ?? "5042002");
  const base = {
    dryRun,
    chainId,
    msbAgentBaseUrl: env["MSB_AGENT_BASE_URL"] ?? DEFAULT_MSB_AGENT_BASE_URL,
    adjudicatorMode: env["ADJUDICATOR_MODE"] ?? (dryRun ? "cache_first" : "cache_only"),
  } as const;

  if (dryRun && !hasAllKeys(env)) {
    // 没有 .env 也能排练一遍流程形状——但绝不假装它连过链。
    return {
      ...base,
      ephemeralKeys: true,
      keys: ephemeralKeys(),
      jobContract: optionalAddress(env, "JOB_CONTRACT_ADDRESS"),
      usdc: optionalAddress(env, "USDC_ADDRESS"),
      rpcUrl: env["ARC_RPC_URL"] ?? null,
    };
  }

  const keys: SliceKeys = {
    marketplace: requireKey(env, "MARKETPLACE_PRIVATE_KEY"),
    operator: requireKey(env, "OPERATOR_PRIVATE_KEY"),
    verifier: requireKey(env, "VERIFIER_PRIVATE_KEY"),
    procurement: requireKey(env, "PROCUREMENT_PRIVATE_KEY"),
  };
  assertDistinctKeys(keys);

  if (dryRun) {
    // dry-run 仍不发交易，但把地址带上：费率要真读链上 view。
    return {
      ...base,
      ephemeralKeys: false,
      keys,
      jobContract: optionalAddress(env, "JOB_CONTRACT_ADDRESS"),
      usdc: optionalAddress(env, "USDC_ADDRESS"),
      rpcUrl: env["ARC_RPC_URL"] ?? null,
    };
  }
  return {
    ...base,
    ephemeralKeys: false,
    keys,
    jobContract: requireAddress(env, "JOB_CONTRACT_ADDRESS"),
    usdc: requireAddress(env, "USDC_ADDRESS"),
    rpcUrl: env["ARC_RPC_URL"] ?? null,
  };
}

/**
 * 断言四把密钥互不相同（v2.2 §2.3 密钥物理分离）。
 *
 * 比较派生地址而不是私钥字符串：同一把钥匙写成不同大小写仍然是同一把钥匙。
 *
 * @param keys - 四把密钥
 * @throws {SliceConfigError} 任意两个角色共用同一把钥匙
 */
export function assertDistinctKeys(keys: SliceKeys): void {
  const seen = new Map<string, string>();
  for (const [role, key] of Object.entries(keys)) {
    const address = privateKeyToAccount(key as Hex).address.toLowerCase();
    const previous = seen.get(address);
    if (previous !== undefined) {
      throw new SliceConfigError(
        `角色 ${previous} 与 ${role} 用了同一把密钥：四把密钥必须物理分离（v2.2 §2.3）`,
      );
    }
    seen.set(address, role);
  }
}

/** 四个角色的公开地址。打印用——地址不是秘密。 */
export interface SliceAddresses {
  readonly marketplace: Address;
  readonly operator: Address;
  readonly verifier: Address;
  readonly procurement: Address;
}

/**
 * 由密钥派生四个角色地址。
 *
 * @param keys - 四把密钥
 * @returns 四个角色的地址
 */
export function deriveAddresses(keys: SliceKeys): SliceAddresses {
  return {
    marketplace: privateKeyToAccount(keys.marketplace).address,
    operator: privateKeyToAccount(keys.operator).address,
    verifier: privateKeyToAccount(keys.verifier).address,
    procurement: privateKeyToAccount(keys.procurement).address,
  };
}
