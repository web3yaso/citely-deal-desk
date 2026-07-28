/**
 * 客户侧演示 agent 的环境读取——**全进程唯一**的环境变量出口。
 *
 * 这个 agent 扮演的是**客户**（8183 的 `client` 角色，合约 §2.1），它跟 Citely
 * 是两方。因此它只允许看见 {@link MARKETPLACE_PRIVATE_KEY_VAR} 一把钥匙：
 *
 * - **尤其不许读 `OPERATOR_PRIVATE_KEY`**——客户侧 agent 一旦拿到运营密钥，
 *   "SA 由钱包按自有预设策略独立核验"这套叙事就整个塌了：核验方与出具方成了同一个人；
 * - 也不读验证器 / 采购 / Module 认证密钥与 `OPENAI_API_KEY`——都不是客户的东西。
 *
 * "不读"由 `key-source.test.ts` 用记录型 Proxy 断言（读了哪些键是可观测的），
 * 不靠自觉。任何新增的环境变量读取都必须回到这里，并同步更新那条负向测试。
 */

import type { Hex } from "viem";

/** 客户侧 agent 唯一允许读取的环境变量名。 */
export const MARKETPLACE_PRIVATE_KEY_VAR = "MARKETPLACE_PRIVATE_KEY";

/**
 * 客户侧 agent **禁止**读取的环境变量名。
 * 仅用于文档与边界测试，运行时不会去访问它们。
 */
export const FORBIDDEN_ENV_VARS: readonly string[] = [
  // 这一条是本清单存在的首要理由，见文件头注释。
  "OPERATOR_PRIVATE_KEY",
  "VERIFIER_PRIVATE_KEY",
  "PROCUREMENT_PRIVATE_KEY",
  "MODULE_ATTESTER_PRIVATE_KEY",
  "OPENAI_API_KEY",
];

/** 环境读取失败。message 只描述变量名与形状，**绝不包含变量值**。 */
export class MarketplaceKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MarketplaceKeyError";
  }
}

/** 环境变量来源。注入是为了让测试能观测"读了哪些键"。 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface MarketplaceKeyMaterial {
  /** 客户钱包私钥：createJob / approve+fund / claimRefund / 对收款方付款。 */
  readonly privateKey: Hex;
}

const PRIVATE_KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * 读取并校验客户钱包私钥。
 *
 * @param source - 环境变量来源，默认 `process.env`
 * @returns 已校验形状的客户钱包私钥
 * @throws {MarketplaceKeyError} 变量缺失或形状不是 `0x` + 64 位十六进制
 */
export function readMarketplaceKey(source: EnvSource = process.env): MarketplaceKeyMaterial {
  const raw = source[MARKETPLACE_PRIVATE_KEY_VAR];
  if (raw === undefined || raw === "") {
    throw new MarketplaceKeyError(
      `${MARKETPLACE_PRIVATE_KEY_VAR} is not set (copy .env.example to .env and fill it)`,
    );
  }
  if (!PRIVATE_KEY_SHAPE.test(raw)) {
    // 只报形状不报值：错误消息可能进日志。
    throw new MarketplaceKeyError(
      `${MARKETPLACE_PRIVATE_KEY_VAR} must be 0x-prefixed 32-byte hex (got ${String(raw.length)} chars)`,
    );
  }
  return { privateKey: raw as Hex };
}
