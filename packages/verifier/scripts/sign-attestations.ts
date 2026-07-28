/**
 * 离线签发 Module 版本认证清单（合约 §6.2 检查②的上游）。
 *
 * 用法：
 * ```
 * MODULE_ATTESTER_PRIVATE_KEY=0x… pnpm -F @citely/verifier sign:attestations
 * ```
 *
 * 纪律：
 * - 用的是 **Module 认证密钥**，与验证器密钥、运营密钥物理分离（v2.2 §2.3）。
 *   验证器运行时进程**不持有**这把钥匙——它只验签公开地址；
 * - 本脚本是薄壳，全部确定性逻辑在 `src/attestation-source.ts`（可单测）；
 * - **不打印私钥**，只打印派生地址与清单摘要，供人工核对后填进
 *   `attestations/registry.json` 的 `moduleAttesters`；
 * - 任何一步失败都响亮抛错中止，绝不写出半份清单。
 */

import { readFileSync, writeFileSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { parseAttestationSource, signAttestationSource } from "../src/attestation-source.js";
import { MODULE_MANIFEST_PATH, MODULE_SOURCE_PATH } from "../src/paths.js";
import { safeErrorMessage } from "../src/redact.js";

/**
 * 本脚本唯一读取的环境变量。
 *
 * 它出现在 `scripts/` 而不是 `src/` 是刻意的：`src/key-source.test.ts` 的静态扫描
 * 断言**运行时源码**里不得出现除验证器密钥外的任何密钥变量名。离线签名是运维动作，
 * 不属于验证器运行时。
 */
const ATTESTER_KEY_VAR = "MODULE_ATTESTER_PRIVATE_KEY";

const PRIVATE_KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * 从 argv 取一个 `--flag value` 形式的参数。
 *
 * @param flag - 参数名（含 `--`）
 * @param fallback - 未提供时的默认值
 * @returns 参数值
 */
function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * 读取 Module 认证私钥。
 *
 * @returns 已校验形状的私钥
 * @throws {Error} 变量缺失或形状非法（消息里只有变量名与长度，没有值）
 */
function readAttesterKey(): Hex {
  const raw = process.env[ATTESTER_KEY_VAR];
  if (raw === undefined || raw === "") {
    throw new Error(
      `${ATTESTER_KEY_VAR} is not set (copy .env.example to .env and fill it; this key is offline-only)`,
    );
  }
  if (!PRIVATE_KEY_SHAPE.test(raw)) {
    throw new Error(
      `${ATTESTER_KEY_VAR} must be 0x-prefixed 32-byte hex (got ${String(raw.length)} chars)`,
    );
  }
  return raw as Hex;
}

async function main(): Promise<void> {
  const sourcePath = arg("--source", MODULE_SOURCE_PATH);
  const outPath = arg("--out", MODULE_MANIFEST_PATH);
  const account = privateKeyToAccount(readAttesterKey());

  const source = parseAttestationSource(JSON.parse(readFileSync(sourcePath, "utf8")) as unknown);
  const manifest = await signAttestationSource({ source, sourcePath, account });

  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // 打印给人核对：地址必须与 registry.json 的 moduleAttesters 一致，否则检查②会判"认证方不可信"。
  process.stderr.write(
    [
      `signed ${String(manifest.entries.length)} attestation(s) -> ${outPath}`,
      `attester address: ${account.address}`,
      `  ↳ 请人工核对该地址已出现在 attestations/registry.json 的 moduleAttesters 里`,
      ...manifest.entries.map((e) => `  ${e.module_id}@${e.version} rules_hash=${e.rules_hash}`),
      "",
    ].join("\n"),
  );
}

try {
  await main();
} catch (err) {
  // 不吞错：带上下文重抛前先过遮蔽，避免第三方库把私钥回显进异常。
  process.stderr.write(`sign-attestations failed: ${safeErrorMessage(err)}\n`);
  process.exitCode = 1;
}
