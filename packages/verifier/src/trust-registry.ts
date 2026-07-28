/**
 * 验证器的信任根：谁的签名算数。
 *
 * 落成仓库内的公开注册表（纯地址，无秘密），而不是环境变量——
 * 信任根应当是**可审计、可 diff、可评审**的资产，藏在 `.env` 里没人看得见变更。
 *
 * 两类地址物理分离（v2.2 §2.3 三密钥纪律）：
 * - `citelySigners`：给 SA 签名的 Citely 注册密钥（检查①的信任根）；
 * - `moduleAttesters`：给 Module 版本签认证的**演示认证密钥**（检查②的信任根）。
 *
 * 文件缺失、条目为空、地址重叠都**响亮抛错**——没有"默认信任任何人"这条路。
 */

import { readFileSync } from "node:fs";

import type { Address } from "viem";

import { asAddress, asArray, asRecord, ParseError } from "./parse.js";

export interface TrustRegistry {
  readonly citelySigners: readonly Address[];
  readonly moduleAttesters: readonly Address[];
}

/** 注册表加载失败。 */
export class TrustRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TrustRegistryError";
  }
}

function parseAddressList(value: unknown, path: string): Address[] {
  const list = asArray(value, path).map((item, index) => asAddress(item, `${path}[${String(index)}]`));
  if (list.length === 0) throw new ParseError("expected at least one address", path);
  return list;
}

/**
 * 解析信任注册表。
 *
 * @param raw - 已 `JSON.parse` 的值
 * @returns 校验过的注册表
 * @throws {ParseError} 结构非法或地址列表为空
 * @throws {TrustRegistryError} 两类角色的地址有重叠（违反密钥物理分离）
 */
export function parseTrustRegistry(raw: unknown): TrustRegistry {
  const root = asRecord(raw, "");
  const citelySigners = parseAddressList(root["citelySigners"], "citelySigners");
  const moduleAttesters = parseAddressList(root["moduleAttesters"], "moduleAttesters");

  const signerSet = new Set(citelySigners.map((a) => a.toLowerCase()));
  const overlap = moduleAttesters.filter((a) => signerSet.has(a.toLowerCase()));
  if (overlap.length > 0) {
    throw new TrustRegistryError(
      `citelySigners and moduleAttesters must be physically separate keys; overlapping: ${overlap.join(", ")}`,
    );
  }

  return { citelySigners, moduleAttesters };
}

/**
 * 从磁盘加载信任注册表。
 *
 * @param path - 注册表 JSON 的绝对路径
 * @returns 校验过的注册表
 * @throws {TrustRegistryError} 文件不存在或不是合法 JSON
 */
export function loadTrustRegistry(path: string): TrustRegistry {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new TrustRegistryError(
      `cannot read trust registry at ${path}: ${(err as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TrustRegistryError(`trust registry at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseTrustRegistry(raw);
}
