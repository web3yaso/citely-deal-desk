import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { redactSecrets, safeErrorMessage } from "./redact.js";

describe("redactSecrets", () => {
  // 审查清单 C3：构造含私钥的错误，断言输出是 [REDACTED]。
  it("0x 私钥被替换成 [REDACTED]", () => {
    const key = generatePrivateKey();
    const out = redactSecrets(`rpc rejected tx signed by ${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED]");
  });

  it("OpenAI key 被替换", () => {
    const out = redactSecrets("Authorization failed for sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).toContain("[REDACTED]");
  });

  it("Bearer 头被替换", () => {
    const out = redactSecrets("header: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("不含密钥的文本原样返回", () => {
    expect(redactSecrets("job 12 is in submitted state")).toBe("job 12 is in submitted state");
  });
});

describe("safeErrorMessage", () => {
  it("Error 的 name 与 message 都过遮蔽", () => {
    const key = generatePrivateKey();
    const out = safeErrorMessage(new Error(`failed with ${key}`));
    expect(out).toContain("Error:");
    expect(out).not.toContain(key);
  });

  it("非 Error 抛出物也能安全转字符串", () => {
    const key = generatePrivateKey();
    expect(safeErrorMessage(`raw string ${key}`)).not.toContain(key);
    expect(safeErrorMessage(undefined)).toBe("undefined");
  });
});
