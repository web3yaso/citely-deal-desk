/**
 * 检查②：SA 引用的每个 Module 版本都存在有效认证（合约 §6.2）。
 *
 * 纵切阶段用**离线静态清单**：演示认证密钥对 `{module_id, version, rules_hash}`
 * 做 EIP-712 签名，清单文件落 `packages/verifier/attestations/`。
 * 验证器只做两件事——条目存在、签名有效且出自可信认证方。
 *
 * 认证密钥与验证器密钥是**两把**（v2.2 §2.3）：本文件不接触任何私钥，
 * 只验签公开地址；签清单的动作在 `scripts/sign-attestations.ts` 里离线完成。
 */

import { readFileSync } from "node:fs";

import { verifyTypedData } from "viem";
import type { Address, Hex } from "viem";

import {
  citelyDomain,
  MODULE_ATTESTATION_PRIMARY_TYPE,
  MODULE_ATTESTATION_TYPES,
} from "@citely/engine/sa";
import type { SettlementAuthorization } from "@citely/engine/sa";

import { asAddress, asArray, asHex, asHex32, asRecord, asString } from "../parse.js";
import { outcome } from "./types.js";
import type { CheckFailure, CheckOutcome } from "./types.js";

/** 清单里的一条 Module 版本认证。 */
export interface ModuleAttestationEntry {
  readonly module_id: string;
  /** `YYYY.MM.N` */
  readonly version: string;
  /** rubric 规则集的 sha256（`0x` + 64 hex）。 */
  readonly rules_hash: Hex;
  readonly attester: Address;
  /** EIP-712 签名。 */
  readonly signature: Hex;
}

export interface AttestationManifest {
  /** 清单格式版本。 */
  readonly manifest_version: string;
  readonly entries: readonly ModuleAttestationEntry[];
}

/** 清单加载失败。 */
export class AttestationManifestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AttestationManifestError";
  }
}

function parseEntry(raw: unknown, path: string): ModuleAttestationEntry {
  const rec = asRecord(raw, path);
  return {
    module_id: asString(rec["module_id"], `${path}.module_id`),
    version: asString(rec["version"], `${path}.version`),
    rules_hash: asHex32(rec["rules_hash"], `${path}.rules_hash`),
    attester: asAddress(rec["attester"], `${path}.attester`),
    signature: asHex(rec["signature"], `${path}.signature`),
  };
}

/**
 * 解析认证清单。
 *
 * @param raw - 已 `JSON.parse` 的值
 * @returns 校验过的清单
 * @throws {ParseError} 结构非法
 */
export function parseAttestationManifest(raw: unknown): AttestationManifest {
  const root = asRecord(raw, "");
  const entries = asArray(root["entries"], "entries").map((item, index) =>
    parseEntry(item, `entries[${String(index)}]`),
  );
  return {
    manifest_version: asString(root["manifest_version"], "manifest_version"),
    entries,
  };
}

/**
 * 从磁盘加载认证清单。
 *
 * @param path - 清单 JSON 的绝对路径
 * @returns 校验过的清单
 * @throws {AttestationManifestError} 文件不存在或不是合法 JSON
 */
export function loadAttestationManifest(path: string): AttestationManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new AttestationManifestError(
      `cannot read attestation manifest at ${path}: ${(err as Error).message}`,
    );
  }
  try {
    return parseAttestationManifest(JSON.parse(text) as unknown);
  } catch (err) {
    throw new AttestationManifestError(
      `attestation manifest at ${path} is unusable: ${(err as Error).message}`,
    );
  }
}

/** {@link checkModuleAttestations} 的参数。 */
export interface AttestationCheckInput {
  readonly sa: SettlementAuthorization;
  readonly manifest: AttestationManifest;
  /** 信任根：可信的演示认证密钥地址。 */
  readonly trustedAttesters: readonly Address[];
  readonly chainId?: number;
}

function eqCaseless(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 校验单条认证的 EIP-712 签名。
 *
 * @param entry - 清单条目
 * @param chainId - 链 ID
 * @returns 签名是否有效
 */
export async function verifyAttestationEntry(
  entry: ModuleAttestationEntry,
  chainId?: number,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: entry.attester,
      domain: citelyDomain(chainId),
      types: MODULE_ATTESTATION_TYPES,
      primaryType: MODULE_ATTESTATION_PRIMARY_TYPE,
      message: {
        moduleId: entry.module_id,
        version: entry.version,
        rulesHash: entry.rules_hash,
      },
      signature: entry.signature,
    });
  } catch {
    // 签名字节畸形 = 认证无效，不是验证器故障。
    return false;
  }
}

/**
 * 执行检查②。
 *
 * @param input - SA、认证清单、可信认证方名单
 * @returns 检查结果；SA 未引用任何 Module 也算不通过（无据可依）
 */
export async function checkModuleAttestations(
  input: AttestationCheckInput,
): Promise<CheckOutcome> {
  const { sa, manifest, trustedAttesters, chainId } = input;
  const failures: CheckFailure[] = [];

  if (sa.modules_used.length === 0) {
    failures.push({ code: "no_modules_referenced" });
  }

  for (const used of sa.modules_used) {
    const ref = `${used.module_id}@${used.version}`;
    const entry = manifest.entries.find(
      (e) => e.module_id === used.module_id && e.version === used.version,
    );
    if (entry === undefined) {
      failures.push({ code: "attestation_missing", detail: ref });
      continue;
    }
    if (!trustedAttesters.some((addr) => eqCaseless(addr, entry.attester))) {
      failures.push({ code: "attester_not_trusted", detail: `${ref} by ${entry.attester}` });
      continue;
    }
    if (!(await verifyAttestationEntry(entry, chainId))) {
      failures.push({ code: "attestation_signature_invalid", detail: ref });
    }
  }

  return outcome("module_attestation", failures);
}
