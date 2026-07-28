import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_ENV_VARS,
  MARKETPLACE_PRIVATE_KEY_VAR,
  MarketplaceKeyError,
  readMarketplaceKey,
} from "./key-source.js";

/** 记录被读取过的键，用来断言"其余变量一律不触碰"。 */
function recordingEnv(values: Record<string, string>): {
  readonly source: Record<string, string | undefined>;
  readonly reads: string[];
} {
  const reads: string[] = [];
  const source = new Proxy(values, {
    get(target, prop): string | undefined {
      if (typeof prop === "string") reads.push(prop);
      return Reflect.get(target, prop) as string | undefined;
    },
    has(target, prop): boolean {
      if (typeof prop === "string") reads.push(prop);
      return Reflect.has(target, prop);
    },
  }) as Record<string, string | undefined>;
  return { source, reads };
}

describe("readMarketplaceKey", () => {
  it("返回形状合法的客户钱包私钥", () => {
    const key = generatePrivateKey();
    expect(readMarketplaceKey({ [MARKETPLACE_PRIVATE_KEY_VAR]: key })).toEqual({ privateKey: key });
  });

  it("变量缺失时抛 MarketplaceKeyError（worktree 无 .env 时也要给清晰错误）", () => {
    expect(() => readMarketplaceKey({})).toThrow(MarketplaceKeyError);
    expect(() => readMarketplaceKey({})).toThrow(/MARKETPLACE_PRIVATE_KEY is not set/);
  });

  it("形状非法时抛错，且错误消息不回显变量值", () => {
    const bogus = "not-a-private-key-but-still-secret";
    expect(() => readMarketplaceKey({ [MARKETPLACE_PRIVATE_KEY_VAR]: bogus })).toThrow(
      MarketplaceKeyError,
    );
    try {
      readMarketplaceKey({ [MARKETPLACE_PRIVATE_KEY_VAR]: bogus });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(bogus);
    }
  });

  // 密钥隔离负向测试（叙事红线）：客户侧 agent 拿到运营密钥，整套独立核验就塌了。
  it("喂入全套密钥时只读取 MARKETPLACE_PRIVATE_KEY，尤其不碰 OPERATOR_PRIVATE_KEY", () => {
    const { source, reads } = recordingEnv({
      [MARKETPLACE_PRIVATE_KEY_VAR]: generatePrivateKey(),
      OPERATOR_PRIVATE_KEY: generatePrivateKey(),
      VERIFIER_PRIVATE_KEY: generatePrivateKey(),
      PROCUREMENT_PRIVATE_KEY: generatePrivateKey(),
      MODULE_ATTESTER_PRIVATE_KEY: generatePrivateKey(),
      OPENAI_API_KEY: "sk-test-key-that-must-never-be-read",
      ARC_RPC_URL: "https://example.invalid",
    });

    readMarketplaceKey(source);

    expect(reads).toEqual([MARKETPLACE_PRIVATE_KEY_VAR]);
    expect(reads).not.toContain("OPERATOR_PRIVATE_KEY");
    for (const forbidden of FORBIDDEN_ENV_VARS) {
      expect(reads).not.toContain(forbidden);
    }
  });

  it("禁读清单覆盖 .env.example 里除客户钱包外的全部密钥", () => {
    expect([...FORBIDDEN_ENV_VARS].sort()).toEqual([
      "MODULE_ATTESTER_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "OPERATOR_PRIVATE_KEY",
      "PROCUREMENT_PRIVATE_KEY",
      "VERIFIER_PRIVATE_KEY",
    ]);
    expect(FORBIDDEN_ENV_VARS).not.toContain(MARKETPLACE_PRIVATE_KEY_VAR);
  });
});

/** 递归收集 src/ 下的非测试 .ts 文件。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("进程边界（静态扫描）", () => {
  const files = sourceFiles(import.meta.dirname);

  it("src/ 下扫得到源文件（防止扫描本身空跑）", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("除 key-source.ts 的禁用清单外，没有任何文件提及其他角色的密钥变量", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("key-source.ts")) continue; // 清单常量本身
      const text = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_ENV_VARS) {
        if (text.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("除 key-source.ts 外没有第二个 process.env 读取点", () => {
    const offenders = files.filter(
      (file) =>
        !file.endsWith("key-source.ts") && readFileSync(file, "utf8").includes("process.env"),
    );
    expect(offenders).toEqual([]);
  });
});
