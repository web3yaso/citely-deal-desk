import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AttestationSourceError,
  computeRulesHash,
  MANIFEST_VERSION,
  parseAttestationSource,
  resolveRulesHash,
  signAttestationEntry,
  signAttestationSource,
} from "./attestation-source.js";
import { parseAttestationManifest, verifyAttestationEntry } from "./checks/attestation.js";
import { ParseError } from "./parse.js";

// 单测零网络零密钥：签名密钥当场生成，绝不读 env。
const account = privateKeyToAccount(generatePrivateKey());

let dir: string;
let sourcePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "citely-attest-"));
  sourcePath = join(dir, "modules.source.json");
  writeFileSync(join(dir, "rules.json"), JSON.stringify({ b: 2, a: 1 }), "utf8");
  writeFileSync(join(dir, "rules-reordered.json"), JSON.stringify({ a: 1, b: 2 }), "utf8");
  writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
});

describe("parseAttestationSource", () => {
  it("解析合法源清单，忽略 _comment 之类的额外键", () => {
    const source = parseAttestationSource({
      _comment: "说明文字",
      entries: [{ module_id: "us-msb", version: "2026.07.1", rules_file: "./rules.json" }],
    });
    expect(source.entries).toEqual([
      { module_id: "us-msb", version: "2026.07.1", rules_file: "./rules.json" },
    ]);
  });

  it("既没有 rules_file 也没有 rules_hash → 抛 ParseError", () => {
    expect(() =>
      parseAttestationSource({ entries: [{ module_id: "us-msb", version: "2026.07.1" }] }),
    ).toThrow(ParseError);
  });

  it("空清单 → 抛错（不许签出一份空认证）", () => {
    expect(() => parseAttestationSource({ entries: [] })).toThrow(ParseError);
  });
});

describe("computeRulesHash / resolveRulesHash", () => {
  it("哈希绑内容不绑字节：键序不同的同一份规则算出同一个哈希", () => {
    expect(computeRulesHash({ b: 2, a: 1 })).toBe(computeRulesHash({ a: 1, b: 2 }));
    expect(computeRulesHash({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("内容不同则哈希不同", () => {
    expect(computeRulesHash({ a: 1 })).not.toBe(computeRulesHash({ a: 2 }));
  });

  it("rules_file 优先于手填 rules_hash", () => {
    const hash = resolveRulesHash(
      {
        module_id: "us-msb",
        version: "2026.07.1",
        rules_file: "./rules.json",
        rules_hash: `0x${"0".repeat(64)}`,
      },
      sourcePath,
    );
    expect(hash).toBe(computeRulesHash({ a: 1, b: 2 }));
  });

  it("两份键序不同的快照解析出同一个 rules_hash", () => {
    const a = resolveRulesHash(
      { module_id: "m", version: "1", rules_file: "./rules.json" },
      sourcePath,
    );
    const b = resolveRulesHash(
      { module_id: "m", version: "1", rules_file: "./rules-reordered.json" },
      sourcePath,
    );
    expect(a).toBe(b);
  });

  it("没有快照时退回显式 rules_hash", () => {
    const explicit = `0x${"7".repeat(64)}` as const;
    expect(
      resolveRulesHash({ module_id: "m", version: "1", rules_hash: explicit }, sourcePath),
    ).toBe(explicit);
  });

  it("快照缺失 → 响亮抛错，不静默跳过", () => {
    expect(() =>
      resolveRulesHash({ module_id: "m", version: "1", rules_file: "./nope.json" }, sourcePath),
    ).toThrow(AttestationSourceError);
  });

  it("快照不是合法 JSON → 响亮抛错", () => {
    expect(() =>
      resolveRulesHash({ module_id: "m", version: "1", rules_file: "./broken.json" }, sourcePath),
    ).toThrow(AttestationSourceError);
  });
});

describe("signAttestationSource", () => {
  it("签出的清单能被解析并逐条验签通过（签名侧与验签侧闭环）", async () => {
    const source = parseAttestationSource({
      entries: [
        { module_id: "us-msb", version: "2026.07.1", rules_file: "./rules.json" },
        { module_id: "sg-msb", version: "2026.07.1", rules_hash: `0x${"5".repeat(64)}` },
      ],
    });
    const manifest = await signAttestationSource({ source, sourcePath, account });

    expect(manifest.manifest_version).toBe(MANIFEST_VERSION);
    expect(manifest.entries).toHaveLength(2);
    // 序列化再解析一轮：磁盘往返不该改变任何字段。
    const roundTripped = parseAttestationManifest(JSON.parse(JSON.stringify(manifest)) as unknown);
    for (const entry of roundTripped.entries) {
      expect(entry.attester).toBe(account.address);
      expect(await verifyAttestationEntry(entry)).toBe(true);
    }
  });

  it("篡改 rules_hash 后验签失败", async () => {
    const entry = await signAttestationEntry({
      moduleId: "us-msb",
      version: "2026.07.1",
      rulesHash: `0x${"1".repeat(64)}`,
      account,
    });
    expect(await verifyAttestationEntry(entry)).toBe(true);
    expect(
      await verifyAttestationEntry({ ...entry, rules_hash: `0x${"2".repeat(64)}` }),
    ).toBe(false);
  });

  it("篡改 version 后验签失败（认证绑到具体版本）", async () => {
    const entry = await signAttestationEntry({
      moduleId: "us-msb",
      version: "2026.07.1",
      rulesHash: `0x${"1".repeat(64)}`,
      account,
    });
    expect(await verifyAttestationEntry({ ...entry, version: "2026.08.1" })).toBe(false);
  });

  it("换个 chainId 验签失败（跨链重放挡住）", async () => {
    const entry = await signAttestationEntry({
      moduleId: "us-msb",
      version: "2026.07.1",
      rulesHash: `0x${"1".repeat(64)}`,
      account,
    });
    expect(await verifyAttestationEntry(entry, 1)).toBe(false);
  });

  it("重复的 module@version → 抛错（否则检查②的结果取决于数组顺序）", async () => {
    const source = parseAttestationSource({
      entries: [
        { module_id: "us-msb", version: "2026.07.1", rules_hash: `0x${"1".repeat(64)}` },
        { module_id: "us-msb", version: "2026.07.1", rules_hash: `0x${"2".repeat(64)}` },
      ],
    });
    await expect(signAttestationSource({ source, sourcePath, account })).rejects.toThrow(
      AttestationSourceError,
    );
  });
});
