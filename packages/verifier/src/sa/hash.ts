/**
 * SA 的规范化与哈希（合约 §5）。
 *
 * `deliverableHash = "0x" + sha256(canonicalJson(SA 去 attestation))`。
 * 去掉 `attestation` 是必须的：`attestation.sa_hash` 本身就是这个哈希，
 * 对含它的全文取哈希是循环定义。
 *
 * `canonicalJson` 全仓只有 engine 那一份实现（审查清单 B6），这里只消费。
 */

import { createHash } from "node:crypto";

import { canonicalBytes } from "@citely/engine/util/canonical";
import type { Hex } from "viem";

import type { SaBody, SettlementAuthorization } from "./types.js";

/**
 * 剥掉 `attestation`，取出被签名的 SA 正文。
 *
 * @param sa - 完整 SA
 * @returns 只含正文字段的对象
 */
export function saBody(sa: SettlementAuthorization): SaBody {
  const { attestation: _attestation, ...body } = sa;
  return body;
}

/**
 * 计算 SA 的 deliverableHash。
 *
 * @param body - SA 正文（可直接传完整 SA，会自动剥 attestation）
 * @returns `0x` + 64 位小写十六进制
 */
export function computeDeliverableHash(body: SaBody | SettlementAuthorization): Hex {
  const normalized = "attestation" in body ? saBody(body) : body;
  const digest = createHash("sha256").update(canonicalBytes(normalized)).digest("hex");
  return `0x${digest}`;
}
