import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_ENV_VARS,
  readVerifierKey,
  VERIFIER_PRIVATE_KEY_VAR,
  VerifierKeyError,
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

describe("readVerifierKey", () => {
  it("返回形状合法的验证器私钥", () => {
    const key = generatePrivateKey();
    expect(readVerifierKey({ [VERIFIER_PRIVATE_KEY_VAR]: key })).toEqual({ privateKey: key });
  });

  it("变量缺失时抛 VerifierKeyError", () => {
    expect(() => readVerifierKey({})).toThrow(VerifierKeyError);
  });

  it("形状非法时抛错，且错误消息不回显变量值", () => {
    const bogus = "not-a-private-key-but-still-secret";
    expect(() => readVerifierKey({ [VERIFIER_PRIVATE_KEY_VAR]: bogus })).toThrow(VerifierKeyError);
    try {
      readVerifierKey({ [VERIFIER_PRIVATE_KEY_VAR]: bogus });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(bogus);
    }
  });

  // 负向测试（安全红线）：喂入全套变量，只允许读到验证器自己那一把。
  it("喂入全套密钥时只读取 VERIFIER_PRIVATE_KEY，其余一律不触碰", () => {
    const { source, reads } = recordingEnv({
      [VERIFIER_PRIVATE_KEY_VAR]: generatePrivateKey(),
      OPERATOR_PRIVATE_KEY: generatePrivateKey(),
      MARKETPLACE_PRIVATE_KEY: generatePrivateKey(),
      PROCUREMENT_PRIVATE_KEY: generatePrivateKey(),
      MODULE_ATTESTER_PRIVATE_KEY: generatePrivateKey(),
      OPENAI_API_KEY: "sk-test-key-that-must-never-be-read",
      ARC_RPC_URL: "https://example.invalid",
    });

    readVerifierKey(source);

    expect(reads).toEqual([VERIFIER_PRIVATE_KEY_VAR]);
    for (const forbidden of FORBIDDEN_ENV_VARS) {
      expect(reads).not.toContain(forbidden);
    }
  });

  // 防漂移：清单只要漏一把密钥，上面那条负向测试就测不到它。
  it("禁读清单覆盖 .env.example 里除验证器外的全部密钥", () => {
    expect([...FORBIDDEN_ENV_VARS].sort()).toEqual([
      "MARKETPLACE_PRIVATE_KEY",
      "MODULE_ATTESTER_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "OPERATOR_PRIVATE_KEY",
      "PROCUREMENT_PRIVATE_KEY",
    ]);
    expect(FORBIDDEN_ENV_VARS).not.toContain(VERIFIER_PRIVATE_KEY_VAR);
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
      (file) => !file.endsWith("key-source.ts") && readFileSync(file, "utf8").includes("process.env"),
    );
    expect(offenders).toEqual([]);
  });
});
