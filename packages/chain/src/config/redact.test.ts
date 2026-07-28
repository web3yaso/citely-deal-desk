import { describe, expect, it } from "vitest";

import { redactSecrets, safeErrorMessage } from "./redact.js";

// 测试用假私钥：32 字节全 a，不是任何真实账户。
const FAKE_KEY = `0x${"a".repeat(64)}`;

describe("redactSecrets", () => {
  it("替换带 0x 前缀的密钥", () => {
    expect(redactSecrets(`signing with ${FAKE_KEY} failed`, FAKE_KEY)).toBe(
      "signing with [REDACTED] failed",
    );
  });

  it("替换去掉 0x 前缀的变体", () => {
    const bare = FAKE_KEY.slice(2);
    const redacted = redactSecrets(`key=${bare}`, FAKE_KEY);
    expect(redacted).toBe("key=[REDACTED]");
    expect(redacted).not.toContain(bare);
  });

  it("密钥无 0x 前缀时也补上 0x 变体一起替换", () => {
    const bare = FAKE_KEY.slice(2);
    expect(redactSecrets(`key=${FAKE_KEY}`, bare)).toBe("key=[REDACTED]");
  });

  it("替换同一密钥的多次出现", () => {
    const redacted = redactSecrets(`${FAKE_KEY} and ${FAKE_KEY}`, FAKE_KEY);
    expect(redacted).toBe("[REDACTED] and [REDACTED]");
  });

  it("支持多个密钥且跳过 undefined 与空串", () => {
    const other = `0x${"b".repeat(64)}`;
    expect(redactSecrets(`${FAKE_KEY}|${other}`, FAKE_KEY, undefined, "", other)).toBe(
      "[REDACTED]|[REDACTED]",
    );
  });

  it("没有密钥出现时原样返回", () => {
    expect(redactSecrets("boom", FAKE_KEY)).toBe("boom");
  });
});

describe("safeErrorMessage", () => {
  it("从 Error 提取消息并屏蔽", () => {
    const message = safeErrorMessage(new Error(`rpc rejected ${FAKE_KEY}`), FAKE_KEY);
    expect(message).toBe("rpc rejected [REDACTED]");
    expect(message).not.toContain("aaaa");
  });

  it("非 Error 抛出物走 String() 且同样屏蔽", () => {
    expect(safeErrorMessage(`raw ${FAKE_KEY}`, FAKE_KEY)).toBe("raw [REDACTED]");
  });
});
