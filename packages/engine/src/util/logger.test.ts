import { afterEach, describe, expect, it } from "vitest";

import { clearRegisteredSecrets, redactSecrets, registerSecret } from "./logger.js";

afterEach(() => {
  clearRegisteredSecrets();
});

describe("按形状遮蔽的两类密钥", () => {
  it("OpenAI key", () => {
    expect(redactSecrets("key=sk-proj-abcdefghijklmnop1234")).toBe("key=[REDACTED]");
  });

  it("Bearer 头", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });
});

describe("哈希**不该**被遮蔽（对账与可复算要给人看）", () => {
  const HASH = `0x${"ab".repeat(32)}`;

  it.each([
    ["sa_hash", HASH],
    ["txHash", `0x${"12".repeat(32)}`],
    ["evidence_hash", "ab".repeat(32)],
  ])("%s 原样输出", (_name, value) => {
    expect(redactSecrets(`value=${value}`)).toBe(`value=${value}`);
  });

  it("2026-07-29 的回归：幂等实证要能看到 sa_hash", () => {
    const line = JSON.stringify({ msg: "run 1", sa_hash: HASH });
    expect(redactSecrets(line)).toContain(HASH);
    expect(redactSecrets(line)).not.toContain("[REDACTED]");
  });
});

describe("显式登记的密钥被遮蔽（私钥与哈希形状不可区分，只能靠登记）", () => {
  it("登记后在日志里被替换", () => {
    const key = `0x${"cd".repeat(32)}`;
    expect(redactSecrets(`pk=${key}`)).toBe(`pk=${key}`);
    registerSecret(key);
    expect(redactSecrets(`pk=${key}`)).toBe("pk=[REDACTED]");
  });

  it("同一密钥出现多次全部替换", () => {
    registerSecret("super-secret-value");
    expect(redactSecrets("a=super-secret-value b=super-secret-value")).toBe(
      "a=[REDACTED] b=[REDACTED]",
    );
  });

  it("含正则元字符的密钥按字面量替换，不会当模式解释", () => {
    registerSecret("a+b(c)[d].*");
    expect(redactSecrets("v=a+b(c)[d].*")).toBe("v=[REDACTED]");
    expect(redactSecrets("v=aXbc")).toBe("v=aXbc");
  });

  it("过短的值不登记（免得把正常文本打成筛子）", () => {
    registerSecret("abc");
    expect(redactSecrets("the abc of it")).toBe("the abc of it");
  });

  it("clearRegisteredSecrets 生效", () => {
    registerSecret("another-secret-value");
    expect(redactSecrets("x=another-secret-value")).toContain("[REDACTED]");
    clearRegisteredSecrets();
    expect(redactSecrets("x=another-secret-value")).toBe("x=another-secret-value");
  });
});
