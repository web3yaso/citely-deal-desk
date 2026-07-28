import { createHash } from "node:crypto";

import { canonicalBytes } from "./canonical.js";

/** SHA-256 十六进制摘要（小写，无 `0x` 前缀）。 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** SHA-256 十六进制摘要，带 `0x` 前缀（链上/SA 字段用）。 */
export function sha256Hex0x(input: string | Uint8Array): `0x${string}` {
  return `0x${sha256Hex(input)}`;
}

/**
 * 对任意值的**规范化字节**取 SHA-256。
 * 合约 §5 的 `deliverableHash` 与 golden cache key 都由它产出。
 */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}
