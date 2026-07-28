/**
 * 验证器进程的环境读取——**全进程唯一**的环境变量出口。
 *
 * 安全红线（v2.2 §2.3 / 合约 §8 密钥纪律）：验证器是独立进程、独立密钥。
 * 它只允许看见 {@link VERIFIER_PRIVATE_KEY_VAR} 一把钥匙：
 * - 不读运营 / 采购钱包私钥——验证器不动客户资金；
 * - 不读 `OPENAI_API_KEY`——三检是纯确定性检查，判定回路里没有 LLM。
 *
 * "不读"由 `key-source.test.ts` 用记录型 Proxy 断言（读了哪些键是可观测的），
 * 不靠自觉。任何新增的环境变量读取都必须回到这里，并同步更新那条负向测试。
 */

import type { Hex } from "viem";

/** 验证器唯一允许读取的环境变量名。 */
export const VERIFIER_PRIVATE_KEY_VAR = "VERIFIER_PRIVATE_KEY";

/**
 * 验证器**禁止**读取的环境变量名（其他角色的密钥）。
 * 仅用于文档与边界测试，运行时不会去访问它们。
 *
 * 清单与 `.env.example` 的六类密钥一一对应（合约 §2.1 / §8）：除验证器自己那把，
 * 其余五把全在这里。新增任何一类密钥都必须同步补进本清单，否则边界测试形同虚设。
 */
export const FORBIDDEN_ENV_VARS: readonly string[] = [
  "OPERATOR_PRIVATE_KEY",
  "MARKETPLACE_PRIVATE_KEY",
  "PROCUREMENT_PRIVATE_KEY",
  // 离线签 Module 版本认证的演示密钥：只在 scripts/ 里用，运行时进程绝不持有。
  "MODULE_ATTESTER_PRIVATE_KEY",
  "OPENAI_API_KEY",
];

/** 环境读取失败。message 只描述变量名与形状，**绝不包含变量值**。 */
export class VerifierKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerifierKeyError";
  }
}

/** 环境变量来源。注入是为了让测试能观测"读了哪些键"。 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface VerifierKeyMaterial {
  /** 验证器签名 / 发交易用的私钥。 */
  readonly privateKey: Hex;
}

const PRIVATE_KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * 读取并校验验证器私钥。
 *
 * @param source - 环境变量来源，默认 `process.env`
 * @returns 已校验形状的验证器私钥
 * @throws {VerifierKeyError} 变量缺失或形状不是 `0x` + 64 位十六进制
 */
export function readVerifierKey(source: EnvSource = process.env): VerifierKeyMaterial {
  const raw = source[VERIFIER_PRIVATE_KEY_VAR];
  if (raw === undefined || raw === "") {
    throw new VerifierKeyError(`${VERIFIER_PRIVATE_KEY_VAR} is not set`);
  }
  if (!PRIVATE_KEY_SHAPE.test(raw)) {
    // 只报形状不报值：错误消息可能进日志。
    throw new VerifierKeyError(
      `${VERIFIER_PRIVATE_KEY_VAR} must be 0x-prefixed 32-byte hex (got ${String(raw.length)} chars)`,
    );
  }
  return { privateKey: raw as Hex };
}
