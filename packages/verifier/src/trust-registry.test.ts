import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ParseError } from "./parse.js";
import { TRUST_REGISTRY_EXAMPLE_PATH } from "./paths.js";
import { loadTrustRegistry, parseTrustRegistry, TrustRegistryError } from "./trust-registry.js";

const SIGNER = `0x${"1".repeat(40)}`;
const ATTESTER = `0x${"2".repeat(40)}`;

describe("parseTrustRegistry", () => {
  it("解析两类地址，忽略 _comment 之类的额外键", () => {
    const registry = parseTrustRegistry({
      _comment: "说明文字",
      citelySigners: [SIGNER],
      moduleAttesters: [ATTESTER],
    });
    expect(registry).toEqual({ citelySigners: [SIGNER], moduleAttesters: [ATTESTER] });
  });

  it.each([
    ["citelySigners 为空", { citelySigners: [], moduleAttesters: [ATTESTER] }],
    ["moduleAttesters 为空", { citelySigners: [SIGNER], moduleAttesters: [] }],
    ["缺 citelySigners", { moduleAttesters: [ATTESTER] }],
    ["地址形状非法", { citelySigners: ["0xnope"], moduleAttesters: [ATTESTER] }],
  ])("%s → 抛 ParseError（信任根不许留空）", (_name, raw) => {
    expect(() => parseTrustRegistry(raw)).toThrow(ParseError);
  });

  // v2.2 §2.3 三密钥物理分离：SA 签名者与 Module 认证方是两把钥匙。
  it("两类地址重叠 → 抛 TrustRegistryError（大小写不敏感）", () => {
    const lower = `0x${"ab".repeat(20)}`;
    const upper = `0x${"AB".repeat(20)}`;
    expect(() =>
      parseTrustRegistry({ citelySigners: [lower], moduleAttesters: [upper] }),
    ).toThrow(TrustRegistryError);
  });
});

describe("loadTrustRegistry", () => {
  it("文件缺失 → 响亮抛错，绝不退化成「默认信任任何人」", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "citely-trust-")), "registry.json");
    expect(() => loadTrustRegistry(missing)).toThrow(TrustRegistryError);
  });

  it("文件不是合法 JSON → 响亮抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "citely-trust-"));
    const path = join(dir, "registry.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(() => loadTrustRegistry(path)).toThrow(TrustRegistryError);
  });

  it("读得回写进去的注册表", () => {
    const dir = mkdtempSync(join(tmpdir(), "citely-trust-"));
    const path = join(dir, "registry.json");
    writeFileSync(path, JSON.stringify({ citelySigners: [SIGNER], moduleAttesters: [ATTESTER] }));
    expect(loadTrustRegistry(path)).toEqual({
      citelySigners: [SIGNER],
      moduleAttesters: [ATTESTER],
    });
  });
});

describe("registry.example.json（随包模板）", () => {
  it("模板本身结构合法，能被解析器接受", () => {
    const raw = JSON.parse(readFileSync(TRUST_REGISTRY_EXAMPLE_PATH, "utf8")) as unknown;
    expect(() => parseTrustRegistry(raw)).not.toThrow();
  });

  it("模板里没有任何私钥形状的字符串", () => {
    const text = readFileSync(TRUST_REGISTRY_EXAMPLE_PATH, "utf8");
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
