/**
 * Module 版本认证的**签名侧**纯逻辑（检查②的上游，合约 §6.2）。
 *
 * 分成两层是为了让签名动作可测：
 * - 本文件只做确定性计算（解析源清单、算 `rules_hash`、用**注入的账户**签名），
 *   不读任何环境变量（`key-source.test.ts` 的静态扫描会把违规文件揪出来）；
 * - `scripts/sign-attestations.ts` 是薄壳，负责读 Module 认证密钥、写盘、打印地址。
 *
 * 认证密钥与验证器密钥、运营密钥是**三把不同的钥匙**（v2.2 §2.3）。
 * 这里刻意只接受一个 `LocalAccount`，谁把哪把钥匙塞进来，在调用点一目了然。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalBytes } from "@citely/engine/util/canonical";
import type { Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { AttestationManifest, ModuleAttestationEntry } from "./checks/attestation.js";
import {
  citelyDomain,
  MODULE_ATTESTATION_PRIMARY_TYPE,
  MODULE_ATTESTATION_TYPES,
} from "@citely/engine/sa";
import { asArray, asHex32, asRecord, asString, ParseError } from "./parse.js";

/** 生成的清单格式版本。改动被签字段集时必须递增。 */
export const MANIFEST_VERSION = "1";

/** 源清单里的一条待签认证。 */
export interface AttestationSourceEntry {
  readonly module_id: string;
  /** `YYYY.MM.N` */
  readonly version: string;
  /**
   * 规则集本地快照的路径（相对源清单文件）。给了它就由快照算 `rules_hash`——
   * 认证要绑到**实际规则内容**上，手填哈希等于认证了一个没人核对过的数。
   */
  readonly rules_file?: string;
  /** 直接给定的 `rules_hash`。仅在拿不到快照时使用。 */
  readonly rules_hash?: Hex;
}

export interface AttestationSource {
  readonly entries: readonly AttestationSourceEntry[];
}

/** 源清单不可用。 */
export class AttestationSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AttestationSourceError";
  }
}

function parseSourceEntry(raw: unknown, path: string): AttestationSourceEntry {
  const rec = asRecord(raw, path);
  const rulesFile = rec["rules_file"];
  const rulesHash = rec["rules_hash"];
  if (rulesFile === undefined && rulesHash === undefined) {
    throw new ParseError("expected either rules_file or rules_hash", path);
  }
  return {
    module_id: asString(rec["module_id"], `${path}.module_id`),
    version: asString(rec["version"], `${path}.version`),
    ...(rulesFile === undefined ? {} : { rules_file: asString(rulesFile, `${path}.rules_file`) }),
    ...(rulesHash === undefined ? {} : { rules_hash: asHex32(rulesHash, `${path}.rules_hash`) }),
  };
}

/**
 * 解析待签源清单。
 *
 * @param raw - 已 `JSON.parse` 的值
 * @returns 校验过的源清单
 * @throws {ParseError} 结构非法
 */
export function parseAttestationSource(raw: unknown): AttestationSource {
  const root = asRecord(raw, "");
  const entries = asArray(root["entries"], "entries").map((item, index) =>
    parseSourceEntry(item, `entries[${String(index)}]`),
  );
  if (entries.length === 0) throw new ParseError("expected at least one entry", "entries");
  return { entries };
}

/**
 * 计算规则集快照的 `rules_hash`。
 *
 * 走 `canonicalBytes` 而不是文件原始字节：认证要绑到**内容**上，
 * 缩进或键序变动不该让同一份规则算出两个哈希。
 *
 * @param snapshot - 已 `JSON.parse` 的规则集快照
 * @returns `0x` + 64 位小写十六进制
 */
export function computeRulesHash(snapshot: unknown): Hex {
  return `0x${createHash("sha256").update(canonicalBytes(snapshot)).digest("hex")}`;
}

/**
 * 解析一条源条目的 `rules_hash`（优先用快照算，其次用显式给定值）。
 *
 * @param entry - 源条目
 * @param sourcePath - 源清单文件路径，用于解析相对路径
 * @returns `rules_hash`
 * @throws {AttestationSourceError} 快照文件不可读或不是合法 JSON
 */
export function resolveRulesHash(entry: AttestationSourceEntry, sourcePath: string): Hex {
  if (entry.rules_file === undefined) {
    if (entry.rules_hash === undefined) {
      throw new AttestationSourceError(
        `${entry.module_id}@${entry.version}: neither rules_file nor rules_hash provided`,
      );
    }
    return entry.rules_hash;
  }
  const full = isAbsolute(entry.rules_file)
    ? entry.rules_file
    : resolve(dirname(sourcePath), entry.rules_file);
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (err) {
    throw new AttestationSourceError(
      `${entry.module_id}@${entry.version}: cannot read rules snapshot at ${full}: ${(err as Error).message}`,
    );
  }
  try {
    return computeRulesHash(JSON.parse(text) as unknown);
  } catch (err) {
    throw new AttestationSourceError(
      `${entry.module_id}@${entry.version}: rules snapshot at ${full} is unusable: ${(err as Error).message}`,
    );
  }
}

/**
 * 用给定账户对一条认证做 EIP-712 签名。
 *
 * @param params - module 标识、版本、规则哈希、签名账户与 chainId
 * @returns 可直接写进清单的条目
 */
export async function signAttestationEntry(params: {
  readonly moduleId: string;
  readonly version: string;
  readonly rulesHash: Hex;
  readonly account: LocalAccount;
  readonly chainId?: number;
}): Promise<ModuleAttestationEntry> {
  const signature = await params.account.signTypedData({
    domain: citelyDomain(params.chainId),
    types: MODULE_ATTESTATION_TYPES,
    primaryType: MODULE_ATTESTATION_PRIMARY_TYPE,
    message: {
      moduleId: params.moduleId,
      version: params.version,
      rulesHash: params.rulesHash,
    },
  });
  return {
    module_id: params.moduleId,
    version: params.version,
    rules_hash: params.rulesHash,
    attester: params.account.address,
    signature,
  };
}

/**
 * 把整份源清单签成认证清单。
 *
 * @param params - 源清单、源清单路径（解析相对快照路径用）、签名账户与 chainId
 * @returns 已签名的认证清单
 * @throws {AttestationSourceError} 出现重复的 `module_id@version`
 */
export async function signAttestationSource(params: {
  readonly source: AttestationSource;
  readonly sourcePath: string;
  readonly account: LocalAccount;
  readonly chainId?: number;
}): Promise<AttestationManifest> {
  const seen = new Set<string>();
  const entries: ModuleAttestationEntry[] = [];
  for (const entry of params.source.entries) {
    const ref = `${entry.module_id}@${entry.version}`;
    if (seen.has(ref)) {
      // 同一版本两条认证 = 检查②的 find 结果取决于数组顺序，必须挡死。
      throw new AttestationSourceError(`duplicate attestation entry: ${ref}`);
    }
    seen.add(ref);
    entries.push(
      await signAttestationEntry({
        moduleId: entry.module_id,
        version: entry.version,
        rulesHash: resolveRulesHash(entry, params.sourcePath),
        account: params.account,
        ...(params.chainId === undefined ? {} : { chainId: params.chainId }),
      }),
    );
  }
  return { manifest_version: MANIFEST_VERSION, entries };
}
