import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";

import { signAttestationEntry } from "../attestation-source.js";
import { ParseError } from "../parse.js";
import { fixtureSa, FIXTURE_MODULE } from "../testing/sa-fixture.js";
import type { SettlementAuthorization } from "@citely/engine/sa";
import {
  AttestationManifestError,
  checkModuleAttestations,
  loadAttestationManifest,
  parseAttestationManifest,
} from "./attestation.js";
import type { AttestationManifest, ModuleAttestationEntry } from "./attestation.js";

const attester = privateKeyToAccount(generatePrivateKey());
const otherAttester = privateKeyToAccount(generatePrivateKey());
const saSigner = privateKeyToAccount(generatePrivateKey());

let sa: SettlementAuthorization;
let entry: ModuleAttestationEntry;

beforeAll(async () => {
  sa = await fixtureSa({ account: saSigner });
  entry = await signAttestationEntry({
    moduleId: FIXTURE_MODULE.module_id,
    version: FIXTURE_MODULE.version,
    rulesHash: `0x${"1".repeat(64)}`,
    account: attester,
  });
});

function manifest(entries: readonly ModuleAttestationEntry[]): AttestationManifest {
  return { manifest_version: "1", entries };
}

describe("检查②：Module 版本认证", () => {
  it("条目存在、认证方可信、签名有效 → 通过", async () => {
    const outcome = await checkModuleAttestations({
      sa,
      manifest: manifest([entry]),
      trustedAttesters: [attester.address],
    });
    expect(outcome).toEqual({ check: "module_attestation", passed: true, failures: [] });
  });

  // 合约 §6.2：条目缺失响亮判不通过，不做默认信任。
  it("清单里没有对应条目 → 不通过（attestation_missing）", async () => {
    const outcome = await checkModuleAttestations({
      sa,
      manifest: manifest([]),
      trustedAttesters: [attester.address],
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.failures.map((f) => f.code)).toContain("attestation_missing");
  });

  it("版本对不上 → 不通过（认证绑到具体版本，不是绑到 module）", async () => {
    const stale = await signAttestationEntry({
      moduleId: FIXTURE_MODULE.module_id,
      version: "2025.01.1",
      rulesHash: `0x${"1".repeat(64)}`,
      account: attester,
    });
    const outcome = await checkModuleAttestations({
      sa,
      manifest: manifest([stale]),
      trustedAttesters: [attester.address],
    });
    expect(outcome.failures.map((f) => f.code)).toContain("attestation_missing");
  });

  it("认证方不在信任根里 → 不通过（不接受任意自签）", async () => {
    const rogue = await signAttestationEntry({
      moduleId: FIXTURE_MODULE.module_id,
      version: FIXTURE_MODULE.version,
      rulesHash: `0x${"1".repeat(64)}`,
      account: otherAttester,
    });
    const outcome = await checkModuleAttestations({
      sa,
      manifest: manifest([rogue]),
      trustedAttesters: [attester.address],
    });
    expect(outcome.failures.map((f) => f.code)).toContain("attester_not_trusted");
  });

  it("签名被篡改 → 不通过", async () => {
    const tampered = { ...entry, rules_hash: `0x${"9".repeat(64)}` } as ModuleAttestationEntry;
    const outcome = await checkModuleAttestations({
      sa,
      manifest: manifest([tampered]),
      trustedAttesters: [attester.address],
    });
    expect(outcome.failures.map((f) => f.code)).toContain("attestation_signature_invalid");
  });

  it("签名字节畸形 → 判不通过而不是让验证器崩溃", async () => {
    const broken = { ...entry, signature: "0xdead" } as ModuleAttestationEntry;
    const outcome = await checkModuleAttestations({
      sa,
      manifest: manifest([broken]),
      trustedAttesters: [attester.address],
    });
    expect(outcome.passed).toBe(false);
  });

  it("SA 一个 Module 都没引用 → 不通过（无据可依）", async () => {
    const outcome = await checkModuleAttestations({
      sa: { ...sa, modules_used: [] },
      manifest: manifest([entry]),
      trustedAttesters: [attester.address],
    });
    expect(outcome.failures.map((f) => f.code)).toContain("no_modules_referenced");
  });

  it("信任根为空 → 全部不通过（空名单不等于全都信）", async () => {
    const outcome = await checkModuleAttestations({
      sa,
      manifest: manifest([entry]),
      trustedAttesters: [],
    });
    expect(outcome.passed).toBe(false);
  });
});

describe("清单加载", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "citely-manifest-"));
  });

  it("文件缺失 → 响亮抛 AttestationManifestError", () => {
    expect(() => loadAttestationManifest(join(dir, "nope.json"))).toThrow(
      AttestationManifestError,
    );
  });

  it("文件不是合法 JSON → 响亮抛错", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(() => loadAttestationManifest(path)).toThrow(AttestationManifestError);
  });

  it("结构非法 → 抛 ParseError 并带字段路径", () => {
    expect(() => parseAttestationManifest({ manifest_version: "1", entries: [{}] })).toThrow(
      ParseError,
    );
    try {
      parseAttestationManifest({ manifest_version: "1", entries: [{}] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ParseError).path).toBe("entries[0].module_id");
    }
  });

  it("磁盘往返后条目逐字保持", () => {
    const path = join(dir, "modules.json");
    const written = manifest([entry]);
    writeFileSync(path, JSON.stringify(written, null, 2), "utf8");
    expect(loadAttestationManifest(path)).toEqual(written);
  });
});
