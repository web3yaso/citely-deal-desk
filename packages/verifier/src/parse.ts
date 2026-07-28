/**
 * 手写解析原语（依赖白名单禁 zod / ajv）。
 *
 * 用途：把磁盘上的 JSON（信任注册表、认证清单、SA 卷宗）收窄成本包的类型。
 * 全部走 `unknown` 收窄，不用 `any`；失败一律抛 {@link ParseError} 并带字段路径。
 */

import type { Address, Hex } from "viem";

/** JSON 结构不符合预期。message 含路径，不含值（值可能是业务内容）。 */
export class ParseError extends Error {
  public readonly path: string;

  public constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "ParseError";
    this.path = path;
  }
}

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_SHAPE = /^0x[0-9a-fA-F]{64}$/;
const HEX_SHAPE = /^0x[0-9a-fA-F]+$/;

/** 收窄为纯对象。 */
export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ParseError("expected object", path);
  }
  return value as Record<string, unknown>;
}

/** 收窄为数组。 */
export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ParseError("expected array", path);
  return value;
}

/** 收窄为非空字符串。 */
export function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ParseError("expected non-empty string", path);
  }
  return value;
}

/** 收窄为 EVM 地址。 */
export function asAddress(value: unknown, path: string): Address {
  const raw = asString(value, path);
  if (!ADDRESS_SHAPE.test(raw)) throw new ParseError("expected 0x-prefixed 20-byte address", path);
  return raw as Address;
}

/** 收窄为 32 字节十六进制（bytes32 / sha256）。 */
export function asHex32(value: unknown, path: string): Hex {
  const raw = asString(value, path);
  if (!HEX32_SHAPE.test(raw)) throw new ParseError("expected 0x-prefixed 32-byte hex", path);
  return raw as Hex;
}

/** 收窄为任意长度的十六进制串（签名等）。 */
export function asHex(value: unknown, path: string): Hex {
  const raw = asString(value, path);
  if (!HEX_SHAPE.test(raw)) throw new ParseError("expected 0x-prefixed hex", path);
  return raw as Hex;
}
