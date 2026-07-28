/**
 * 上链理由的规范化与哈希。
 *
 * 不变量 4：链上只有哈希、签名、状态、资金。`complete/reject` 的第二个参数是
 * **`reasonHash`，不是理由明文**——明文留在链下卷宗，链上只放它的 sha256。
 *
 * 进哈希的只有稳定枚举（检查标识 + 失败码），不进 `detail` 自由文本：
 * `detail` 里可能夹带材料片段，且措辞变动会让同样的判定算出不同的哈希。
 */

import { createHash } from "node:crypto";

import { canonicalBytes } from "@citely/engine/util/canonical";
import type { Hex } from "viem";

import type { CheckId, CheckOutcome } from "./checks/types.js";

/** 理由 schema 版本。改动进哈希的字段集时必须递增。 */
export const REASON_VERSION = "1";

/** 单项检查在理由里的投影。 */
export interface ReasonCheck {
  readonly check: CheckId;
  readonly passed: boolean;
  /** 稳定失败码，已排序去重。 */
  readonly codes: readonly string[];
}

/** 上链理由的链下明文。 */
export interface VerificationReason {
  readonly reason_version: string;
  readonly outcome: "accepted" | "rejected";
  /** SA 的 deliverableHash。 */
  readonly sa_hash: Hex;
  readonly job_id: string;
  readonly checks: readonly ReasonCheck[];
}

/**
 * 由三检结果构造理由。
 *
 * @param params - SA 哈希、jobId 与三检结果
 * @returns 可规范化的理由对象
 */
export function buildReason(params: {
  readonly saHash: Hex;
  readonly jobId: string;
  readonly outcomes: readonly CheckOutcome[];
}): VerificationReason {
  const checks = params.outcomes.map((o) => ({
    check: o.check,
    passed: o.passed,
    codes: [...new Set(o.failures.map((f) => f.code))].sort(),
  }));
  return {
    reason_version: REASON_VERSION,
    outcome: checks.every((c) => c.passed) ? "accepted" : "rejected",
    sa_hash: params.saHash,
    job_id: params.jobId,
    checks,
  };
}

/**
 * 计算上链的 `reasonHash`。
 *
 * @param reason - 链下理由明文
 * @returns `0x` + 64 位小写十六进制
 */
export function reasonHash(reason: VerificationReason): Hex {
  const digest = createHash("sha256").update(canonicalBytes(reason)).digest("hex");
  return `0x${digest}`;
}
