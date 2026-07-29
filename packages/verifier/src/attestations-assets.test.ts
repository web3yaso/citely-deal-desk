/**
 * 入库的正式信任根资产自检（零网络）。
 *
 * `registry.json` / `modules.json` 是**入库且会被真链读取**的安全资产，
 * 改坏了不会有编译错误、只会在演示现场变成"检查①②全不过"或者更糟——
 * 悄悄信任了不该信的地址。这里把它们的不变式钉死。
 *
 * 本文件不联网：版本号与线上的一致性由 `scripts/snapshot-module-rules.ts`
 * 重跑保证，这里只保证**清单与本地快照自洽**。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeRulesHash } from "./attestation-source.js";
import { loadAttestationManifest, verifyAttestationEntry } from "./checks/attestation.js";
import { ATTESTATIONS_DIR, MODULE_MANIFEST_PATH, TRUST_REGISTRY_PATH } from "./paths.js";
import { loadTrustRegistry } from "./trust-registry.js";

/** doctor 实测地址（合约 §2.1 / §5.1）。改钱包时这里必须同步改。 */
const OPERATOR_ADDRESS = "0x45698638CFF60B188E338aa580e11ba9eb560759";
const VERIFIER_ADDRESS = "0x07b59ee130519581cd79Bd38B025c9d50eB425E3";
const MODULE_ATTESTER_ADDRESS = "0x1423BDE806123132ec1422f8B9FF517e75ff8e92";

const assetsPresent = existsSync(TRUST_REGISTRY_PATH) && existsSync(MODULE_MANIFEST_PATH);

describe.runIf(assetsPresent)("正式信任根资产", () => {
  const registry = loadTrustRegistry(TRUST_REGISTRY_PATH);
  const manifest = loadAttestationManifest(MODULE_MANIFEST_PATH);

  it("citelySigners 是**运营**地址，不是验证器地址（合约 §5.1）", () => {
    expect(registry.citelySigners).toEqual([OPERATOR_ADDRESS]);
    // 自己签自己验 = 检查①价值归零，这条要单独响一声。
    expect(registry.citelySigners).not.toContain(VERIFIER_ADDRESS);
  });

  it("moduleAttesters 是 Module 认证地址，且与签名者不重叠", () => {
    expect(registry.moduleAttesters).toEqual([MODULE_ATTESTER_ADDRESS]);
    const signers = new Set(registry.citelySigners.map((a) => a.toLowerCase()));
    expect(registry.moduleAttesters.some((a) => signers.has(a.toLowerCase()))).toBe(false);
  });

  it("入库资产里没有任何私钥形状的串", () => {
    // registry 只有 20 字节地址；32 字节 hex 出现在这里就是事故。
    expect(readFileSync(TRUST_REGISTRY_PATH, "utf8")).not.toMatch(/0x[0-9a-fA-F]{64}/);
    const manifestText = readFileSync(MODULE_MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(manifestText) as { entries: Record<string, unknown>[] };
    // 清单里允许出现 32 字节 hex，但只能是 rules_hash / signature 两个字段。
    for (const entry of parsed.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "attester",
        "module_id",
        "rules_hash",
        "signature",
        "version",
      ]);
    }
  });

  it("每条认证都验签通过且出自可信认证方", async () => {
    expect(manifest.entries.length).toBeGreaterThan(0);
    for (const entry of manifest.entries) {
      expect(await verifyAttestationEntry(entry)).toBe(true);
      expect(registry.moduleAttesters).toContain(entry.attester);
    }
  });

  // 认证要绑到实际规则内容上：任何人都能从快照复算出同一个哈希。
  it("每条 rules_hash 都能从随包快照独立复算出来", () => {
    for (const entry of manifest.entries) {
      const snapshotPath = join(
        ATTESTATIONS_DIR,
        "rules",
        `${entry.module_id}@${entry.version}.json`,
      );
      expect(existsSync(snapshotPath)).toBe(true);
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
      expect(computeRulesHash(snapshot)).toBe(entry.rules_hash);
    }
  });

  it("快照里记录的版本与清单条目一致（防止誊错版本号）", () => {
    for (const entry of manifest.entries) {
      const snapshot = JSON.parse(
        readFileSync(
          join(ATTESTATIONS_DIR, "rules", `${entry.module_id}@${entry.version}.json`),
          "utf8",
        ),
      ) as { descriptor: { module: string; version: string } };
      expect(snapshot.descriptor.module).toBe(entry.module_id);
      expect(snapshot.descriptor.version).toBe(entry.version);
    }
  });

  it("没有重复的 module@version（否则检查②的结果取决于数组顺序）", () => {
    const refs = manifest.entries.map((e) => `${e.module_id}@${e.version}`);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
