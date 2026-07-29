import { keccak256, toHex, type Hex } from "viem";

/**
 * 文本 → `bytes32`（keccak256）。
 *
 * 8183 的 `deliverable` 与 `reason` 都是 `bytes32`：链上只放哈希，
 * 业务内容永不上链（架构不变量 4）。
 *
 * @param text - 要哈希的文本
 * @returns 32 字节十六进制
 */
export function bytes32FromText(text: string): Hex {
  return keccak256(toHex(text));
}
