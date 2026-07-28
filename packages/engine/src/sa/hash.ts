/**
 * SA 的规范化与哈希（合约 §5）。
 *
 * `deliverableHash = "0x" + sha256(canonicalJson(SA 去 attestation))`。
 * 去掉 `attestation` 是必须的：`attestation.sa_hash` 本身就是这个哈希，
 * 对含它的全文取哈希是循环定义。
 *
 * 规范化只有 `util/canonical.ts` 一份实现（全仓唯一），这里只消费。
 */

import type { Hex } from "viem";

import { canonicalBytes } from "../util/canonical.js";
import { sha256Hex0x } from "../util/hash.js";
import type { SaBody, SettlementAuthorization } from "./types.js";

/**
 * 剥掉 `attestation`，取出被签名的 SA 正文。
 *
 * 逐字段显式列举而不是解构剩余（`const { attestation, ...body } = sa`）：
 * 这样给 `SaBody` 加字段却忘了在这里带上时，**编译期就红**，
 * 而不是悄悄算出一个漏字段的哈希——漏字段的哈希是能验过签的假签名。
 *
 * @param sa - 完整 SA
 * @returns 只含正文字段的对象
 */
export function saBody(sa: SettlementAuthorization): SaBody {
  return {
    case_id: sa.case_id,
    sa_version: sa.sa_version,
    bound_to: sa.bound_to,
    modules_used: sa.modules_used,
    legs: sa.legs,
    preview: sa.preview,
  };
}

/**
 * 计算 SA 的 deliverableHash。
 *
 * @param body - SA 正文（可直接传完整 SA，会自动剥 attestation）
 * @returns `0x` + 64 位小写十六进制
 */
export function computeDeliverableHash(body: SaBody | SettlementAuthorization): Hex {
  const normalized = "attestation" in body ? saBody(body) : body;
  return sha256Hex0x(canonicalBytes(normalized));
}
