/**
 * 服务侧环境读取——**主服务进程唯一**的环境变量出口。
 *
 * 安全红线（合约 §8 密钥纪律）：主服务持有运营 / 客户 / 采购三把钥匙，
 * **绝不读 `VERIFIER_PRIVATE_KEY`**——验证器是独立进程、独立密钥。
 * 这条"不读"由 `config.test.ts` 用记录型 Proxy 断言（读了哪些键是可观测的），
 * 与 `packages/verifier/src/key-source.ts` 的负向测试互为镜像，不靠自觉。
 *
 * 变量名一律复用 `@citely/chain` 的 `ENV_KEYS`，不在这里另造一套——
 * 同一个变量两处定义，迟早会出现"文档写 A、代码读 B"。
 */

import {
  ARC_TESTNET_CHAIN_ID,
  ENV_KEYS,
  isModuleId,
  loadSellerPaymentConfig,
  MODULE_IDS,
  optionalEnv,
  readAddress,
  readPositiveInt,
  readPrivateKey,
  readUrl,
  requireEnv,
} from "@citely/chain";
import type { EnvSource, ModuleId, SellerPaymentConfig } from "@citely/chain";
import {
  findRepoRoot,
  formatUsdc6,
  USDC_DECIMALS,
  usdc6FromAtomicString,
  usdc6FromDecimal,
} from "@citely/engine";
import type { Usdc6 } from "@citely/engine";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Address, Hex } from "viem";

import { resolvePublicBaseUrl } from "./public-url.js";

/**
 * 主服务**禁止**读取的环境变量名。
 *
 * 与 `packages/verifier/src/key-source.ts` 的 `FORBIDDEN_ENV_VARS` 是同一条纪律的
 * 两个方向：验证器只许读自己那把，主服务恰好不许读那一把。
 */
export const FORBIDDEN_ENV_VARS: readonly string[] = ["VERIFIER_PRIVATE_KEY"];

/** 验证器服务地址的变量名（内部地址，**绝不进 agent card**）。 */
export const VERIFIER_URL_ENV = "VERIFIER_URL";

/** 主服务与验证器服务之间的共享令牌变量名。 */
export const INTERNAL_TOKEN_ENV = "INTERNAL_SERVICE_TOKEN";

/** 验证器地址（公开信息，不是密钥）：`createJob` 要把它写成 evaluator。 */
export const VERIFIER_ADDRESS_ENV = "VERIFIER_ADDRESS";

/** 案件费（escrow 预算）的变量名。 */
export const CASE_BUDGET_ENV = "CASE_BUDGET_USDC";

/** 采购 Module 报价的变量名（进账本的 `amount_nominal`）。 */
export const MODULE_PRICE_ENV = "MODULE_PRICE_USDC";

/** 要采购的 Module id。 */
export const MODULE_ID_ENV = "MODULE_ID";

/** 判定用的 rubric 文件路径。相对路径按**仓库根**解析。 */
export const RUBRIC_PATH_ENV = "RUBRIC_PATH";

/** 配置缺失或自相矛盾。message 只描述变量名，**绝不包含变量值**。 */
export class ServerConfigError extends Error {
  /** 逐项问题。聚合报错时非空。 */
  public readonly issues: readonly ConfigIssue[];

  public constructor(
    message: string,
    options?: { cause?: unknown; issues?: readonly ConfigIssue[] },
  ) {
    super(message, options);
    this.name = "ServerConfigError";
    this.issues = options?.issues ?? [];
  }
}

/** 一条配置问题。 */
export interface ConfigIssue {
  readonly name: string;
  readonly reason: string;
}

/**
 * 问题收集器：**把全部配置问题一次收齐再报**，而不是撞一个报一个。
 *
 * 逐个报的代价在部署时被放大：Railway 上补一个变量就是一轮完整部署，
 * 缺 7 个就是 7 轮。主导本地实测撞了 7 次才起来——这不是配置问题，是报错设计问题。
 */
class IssueCollector {
  readonly #issues: ConfigIssue[] = [];

  /** 记一条问题。 */
  public add(name: string, reason: string): void {
    this.#issues.push({ name, reason });
  }

  /**
   * 跑一个可能抛错的读取；抛了就记下来并返回 `undefined`，**不中断**后续检查。
   */
  public capture<T>(name: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error: unknown) {
      // 只取 message：chain 的配置错误消息本身不含密钥值（私钥错误只说形状）。
      this.add(name, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  public get issues(): readonly ConfigIssue[] {
    return this.#issues;
  }

  /**
   * 有问题就一次性抛出。
   *
   * @throws {ServerConfigError} 收集到任何问题
   */
  public throwIfAny(): void {
    if (this.#issues.length === 0) return;
    const lines = this.#issues.map((issue) => `  · ${issue.name} —— ${issue.reason}`);
    throw new ServerConfigError(
      `配置不完整，共 ${String(this.#issues.length)} 项问题：\n${lines.join("\n")}\n` +
        "请对照仓库根 .env.example 一次补齐后重试。",
      { issues: this.#issues },
    );
  }
}

/** 主服务持有的三把钥匙。**没有验证器那一把。** */
export interface ServerKeys {
  /** 8183 client：createJob / approve+fund。 */
  readonly marketplace: Hex;
  /** 8183 provider：setBudget / submit；也是 SA 的签名者（合约 §5.1）。 */
  readonly operator: Hex;
  /** x402 采购钱包，不参与 8183。 */
  readonly procurement: Hex;
}

/**
 * 三检与收口的落地方式。
 *
 * `remote` 是目标形态：验证器是 Railway 上的第二个服务，主服务不持有它的密钥。
 * `in-process` 只用于本地联调——它意味着**同一进程持有全部密钥**，
 * "独立验证器、独立密钥"这条对外主张在该模式下**不成立**，启动时必须打横幅。
 */
export type VerifierWiring =
  | { readonly mode: "remote"; readonly url: string; readonly token: string }
  | { readonly mode: "in-process" };

export interface ServerConfig {
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly seller: SellerPaymentConfig;
  readonly chainId: number;
  readonly rpcUrl: string | undefined;
  readonly jobContract: Address;
  readonly usdc: Address;
  readonly keys: ServerKeys;
  /** 验证器地址（公开信息）。 */
  readonly verifierAddress: Address;
  readonly verifier: VerifierWiring;
  readonly msbAgentBaseUrl: string;
  readonly caseBudget: Usdc6;
  readonly moduleId: ModuleId;
  readonly modulePrice: Usdc6;
  /** rubric 文件的**绝对**路径（已确认存在）。 */
  readonly rubricPath: string;
  readonly agentId: number | undefined;
  readonly identityRegistry: string | undefined;
}

/**
 * 把配置里的路径解析成**绝对路径，基准是仓库根，不是 cwd**。
 *
 * 与 engine `db/path.ts` 同一条纪律、同一个 `findRepoRoot()`：本项目有多个入口
 * （`pnpm -F @citely/server start` 的 cwd 是包目录，`node demo/...` 的 cwd 是仓库根），
 * 相对路径 + 多入口 = 同一个配置值在不同入口指向不同文件。
 * `DB_PATH` 当初就是这么分裂成两个库的，`RUBRIC_PATH` 不该再犯一次。
 *
 * @param configured - 配置里写的路径
 * @returns 绝对路径
 */
function resolveFromRepoRoot(configured: string): string {
  return isAbsolute(configured) ? configured : resolve(findRepoRoot(), configured);
}

/**
 * 读 rubric 路径并确认文件存在。
 *
 * **在启动时就检查存在性**：否则要等第一个案件进来才炸成 ENOENT，
 * 而那时已经收过钱了。
 */
function readRubricPath(env: EnvSource, issues: IssueCollector): string | undefined {
  const raw = optionalEnv(env, RUBRIC_PATH_ENV);
  if (raw === undefined) {
    issues.add(RUBRIC_PATH_ENV, "缺失：判定用的 rubric 文件路径（相对路径按仓库根解析）");
    return undefined;
  }
  const absolute = resolveFromRepoRoot(raw);
  if (!existsSync(absolute)) {
    // 报解析后的绝对路径——只说"文件不存在"而不说找的是哪个文件，等于让人继续猜。
    issues.add(RUBRIC_PATH_ENV, `文件不存在：${absolute}（相对路径按仓库根解析）`);
    return undefined;
  }
  return absolute;
}

function readUsdc(env: EnvSource, name: string, hint: string): Usdc6 {
  const raw = requireEnv(env, name, hint);
  try {
    return usdc6FromDecimal(raw);
  } catch (error: unknown) {
    // 带上下文重抛，但不回显值——金额不是秘密，可它可能被误配成别的东西。
    throw new ServerConfigError(`环境变量 ${name} 不是合法的 USDC 金额`, { cause: error });
  }
}

/**
 * 读取并校验 `MODULE_ID`。未设置时回落 `us-msb`（与历史行为一致）。
 *
 * **为什么要校验**：这个值会被拼进 `POST /modules/:id/check` 的 URL，而那是一个
 * 会真的花钱的端点。不校验的话，一个拼错的字母要等到第一个案件真正付款那一刻
 * 才炸成 404——钱已经进了 x402 流程，人还在猜哪里配错了。
 *
 * 报错消息里列出**全部合法取值**（这些是公开的模块 id，不是秘密），
 * 但**不回显**配错的值本身，与本文件其他读取器的纪律一致。
 *
 * @param env - 环境变量来源
 * @returns 已校验的 Module id
 * @throws {ServerConfigError} 值不在已上线的 Module 白名单里
 */
function readModuleId(env: EnvSource): ModuleId {
  const raw = optionalEnv(env, MODULE_ID_ENV);
  if (raw === undefined) return "us-msb";
  if (!isModuleId(raw)) {
    throw new ServerConfigError(
      `环境变量 ${MODULE_ID_ENV} 不是已上线的 Module id（合法取值：${MODULE_IDS.join("|")}）`,
    );
  }
  return raw;
}

function readAgentId(env: EnvSource): number | undefined {
  const raw = optionalEnv(env, ENV_KEYS.agentId);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new ServerConfigError(`环境变量 ${ENV_KEYS.agentId} 必须是非负整数`);
  }
  return Number(raw);
}

function readVerifierWiring(env: EnvSource): VerifierWiring {
  const url = optionalEnv(env, VERIFIER_URL_ENV);
  if (url === undefined) {
    // **不静默降级**：没配远端验证器地址就必须显式声明走进程内模式，
    // 否则"独立验证器"这条主张会在无人察觉的情况下变成假的。
    if (optionalEnv(env, "VERIFIER_MODE") !== "in-process") {
      throw new ServerConfigError(
        `未配置 ${VERIFIER_URL_ENV}；如确实要在同一进程内跑验证器（本地联调），` +
          "请显式设置 VERIFIER_MODE=in-process——该模式下同一进程持有全部密钥，" +
          "「独立验证器、独立密钥」不成立",
      );
    }
    return { mode: "in-process" };
  }
  return {
    mode: "remote",
    url: readUrl(env, VERIFIER_URL_ENV, "验证器服务的内部地址"),
    token: requireEnv(env, INTERNAL_TOKEN_ENV, "主服务与验证器之间的共享令牌"),
  };
}

/**
 * 读取主服务配置。
 *
 * @param env - 环境变量来源，默认 `process.env`
 * @returns 已校验的服务配置
 * @throws {ServerConfigError} 必需项缺失或形状非法
 */
export function loadServerConfig(env: EnvSource = process.env): ServerConfig {
  const issues = new IssueCollector();

  // 卖方配置整体 capture：chain 的加载器内部也是撞一个抛一个，所以先各自
  // 探一遍必填项的**存在性**，让缺失项能一次报全；形状校验仍归 chain。
  const sellMode = optionalEnv(env, ENV_KEYS.sellMode) ?? "x402-arc-testnet";
  let sellerVarMissing = false;
  if (sellMode !== "off") {
    for (const [name, hint] of [
      [ENV_KEYS.facilitatorUrl, "Circle x402 facilitator 地址"],
      [ENV_KEYS.sellPayTo, "卖出判定的 USDC 收款地址"],
      [ENV_KEYS.publicBaseUrl, "本服务的公网基址（Railway 域名，付费模式必须 HTTPS）"],
    ] as const) {
      if (optionalEnv(env, name) === undefined) {
        issues.add(name, `缺失：${hint}`);
        sellerVarMissing = true;
      }
    }
  }
  // 上面已逐项报过就不再跑 chain 的加载器：它只会把同一个原因换个变量名再报一遍，
  // 而重复行会让"共 N 项"这个数字失真，人反而数不清到底要补几个。
  const seller = sellerVarMissing
    ? undefined
    : issues.capture(ENV_KEYS.sellMode, () => loadSellerPaymentConfig(env));
  const port = issues.capture("PORT", () => readPositiveInt(env, "PORT", 3000)) ?? 3000;

  const publicBaseUrl =
    seller === undefined
      ? undefined
      : issues.capture(ENV_KEYS.publicBaseUrl, () =>
          resolvePublicBaseUrl(env, { paymentEnabled: seller.mode !== "off", port }),
        );

  const chainId =
    issues.capture(ENV_KEYS.chainId, () =>
      readPositiveInt(env, ENV_KEYS.chainId, ARC_TESTNET_CHAIN_ID),
    ) ?? ARC_TESTNET_CHAIN_ID;
  const jobContract = issues.capture(ENV_KEYS.jobContract, () =>
    readAddress(env, ENV_KEYS.jobContract, "ERC-8183 合约地址"),
  );
  const usdc = issues.capture(ENV_KEYS.usdc, () =>
    readAddress(env, ENV_KEYS.usdc, "Arc Testnet USDC 地址"),
  );
  const marketplace = issues.capture(ENV_KEYS.marketplaceKey, () =>
    readPrivateKey(env, ENV_KEYS.marketplaceKey),
  );
  const operator = issues.capture(ENV_KEYS.operatorKey, () =>
    readPrivateKey(env, ENV_KEYS.operatorKey),
  );
  const procurement = issues.capture(ENV_KEYS.procurementKey, () =>
    readPrivateKey(env, ENV_KEYS.procurementKey),
  );
  const verifierAddress = issues.capture(VERIFIER_ADDRESS_ENV, () =>
    readAddress(env, VERIFIER_ADDRESS_ENV, "验证器钱包地址（公开信息，不是密钥）"),
  );
  const verifier = issues.capture(VERIFIER_URL_ENV, () => readVerifierWiring(env));
  const msbAgentBaseUrl = issues.capture(ENV_KEYS.msbAgentBaseUrl, () =>
    readUrl(env, ENV_KEYS.msbAgentBaseUrl, "合规 Module 服务基址"),
  );
  const caseBudget = issues.capture(CASE_BUDGET_ENV, () =>
    readUsdc(env, CASE_BUDGET_ENV, "案件费（escrow 预算）"),
  );
  const modulePrice = issues.capture(MODULE_PRICE_ENV, () =>
    readUsdc(env, MODULE_PRICE_ENV, "Module 采购报价"),
  );
  const moduleId = issues.capture(MODULE_ID_ENV, () => readModuleId(env));
  const rubricPath = readRubricPath(env, issues);
  const agentId = issues.capture(ENV_KEYS.agentId, () => readAgentId(env));

  // 全部检查跑完才抛——这一行是"一次报全"的关键，别把它挪到上面去。
  issues.throwIfAny();

  // 走到这里所有 capture 都成功了；断言的依据就是上面那次 throwIfAny。
  return {
    port,
    publicBaseUrl: publicBaseUrl as string,
    seller: seller as SellerPaymentConfig,
    chainId,
    rpcUrl: optionalEnv(env, ENV_KEYS.rpcUrl),
    jobContract: jobContract as Address,
    usdc: usdc as Address,
    keys: {
      marketplace: marketplace as Hex,
      operator: operator as Hex,
      procurement: procurement as Hex,
    },
    verifierAddress: verifierAddress as Address,
    verifier: verifier as VerifierWiring,
    msbAgentBaseUrl: msbAgentBaseUrl as string,
    caseBudget: caseBudget as Usdc6,
    moduleId: moduleId as ModuleId,
    modulePrice: modulePrice as Usdc6,
    rubricPath: rubricPath as string,
    agentId,
    identityRegistry: optionalEnv(env, ENV_KEYS.identityRegistry),
  };
}

/**
 * 卖方报价的**对外显示值**（USDC，6 位小数）。
 *
 * chain 的 `priceAtomic` 是**最小单位**（`3.00` USDC → `"3000000"`）。
 * agent card 上那个字段叫 `price_usdc`，直接把原子值填进去等于对外把报价
 * 放大一百万倍——而 card 正是买方用来决定付多少钱的东西。所以这里必须换算，
 * 且单独成函数由测试盯着。
 *
 * @param seller - 卖方配置
 * @returns 形如 `"3.000000"` 的报价；未收费时为 `null`
 */
export function sellerPriceUsdc(seller: SellerPaymentConfig): string | null {
  if (seller.mode === "off") return null;
  return formatUsdc6(usdc6FromAtomicString(seller.priceAtomic), USDC_DECIMALS);
}

/** 验证器服务的配置。**只有它自己那把钥匙 + 公开信息。** */
export interface VerifierServiceConfig {
  readonly port: number;
  readonly token: string;
  readonly chainId: number;
  readonly rpcUrl: string | undefined;
  readonly jobContract: Address;
  readonly usdc: Address;
}

/**
 * 读取验证器服务配置。
 *
 * **刻意不在这里读 `VERIFIER_PRIVATE_KEY`**：那把钥匙的唯一出口是
 * `packages/verifier` 的 `readVerifierKey()`，它带着那份负向测试。
 *
 * @param env - 环境变量来源，默认 `process.env`
 * @returns 已校验的验证器服务配置
 * @throws {ServerConfigError} 必需项缺失
 */
export function loadVerifierServiceConfig(env: EnvSource = process.env): VerifierServiceConfig {
  // 与主服务同一条纪律：一次报全。验证器是第二个 Railway 服务，
  // 它同样是"补一个变量重部署一轮"。
  const issues = new IssueCollector();
  const port = issues.capture("PORT", () => readPositiveInt(env, "PORT", 3001)) ?? 3001;
  const token = issues.capture(INTERNAL_TOKEN_ENV, () =>
    requireEnv(env, INTERNAL_TOKEN_ENV, "主服务与验证器之间的共享令牌"),
  );
  const chainId =
    issues.capture(ENV_KEYS.chainId, () =>
      readPositiveInt(env, ENV_KEYS.chainId, ARC_TESTNET_CHAIN_ID),
    ) ?? ARC_TESTNET_CHAIN_ID;
  const jobContract = issues.capture(ENV_KEYS.jobContract, () =>
    readAddress(env, ENV_KEYS.jobContract, "ERC-8183 合约地址"),
  );
  const usdc = issues.capture(ENV_KEYS.usdc, () =>
    readAddress(env, ENV_KEYS.usdc, "Arc Testnet USDC 地址"),
  );
  issues.throwIfAny();

  return {
    port,
    token: token as string,
    chainId,
    rpcUrl: optionalEnv(env, ENV_KEYS.rpcUrl),
    jobContract: jobContract as Address,
    usdc: usdc as Address,
  };
}
