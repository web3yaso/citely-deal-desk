import { describe, expect, it } from "vitest";

import { ChainError, wrapChainError } from "./errors.js";

const FAKE_KEY = `0x${"c".repeat(64)}`;

describe("ChainError", () => {
  it("把上下文拼进消息", () => {
    const err = new ChainError("发交易失败", {
      action: "fund",
      jobId: 7n,
      txHash: `0x${"1".repeat(64)}`,
    });
    expect(err.message).toBe(
      `发交易失败 [action=fund jobId=7 txHash=0x${"1".repeat(64)}]`,
    );
    expect(err.name).toBe("ChainError");
  });

  it("没有上下文时不加方括号", () => {
    expect(new ChainError("boom").message).toBe("boom");
  });

  it("消息里的私钥被屏蔽", () => {
    const err = new ChainError(`bad key ${FAKE_KEY}`, {}, { secrets: [FAKE_KEY] });
    expect(err.message).toBe("bad key [REDACTED]");
    expect(err.message).not.toContain("cccc");
  });

  it("保留 cause 不吞原错误", () => {
    const cause = new Error("underlying");
    expect(new ChainError("boom", {}, { cause }).cause).toBe(cause);
  });

  it("保留 context 供调用方结构化处理", () => {
    const err = new ChainError("boom", { action: "submit", caseId: "case-1" });
    expect(err.context).toEqual({ action: "submit", caseId: "case-1" });
  });
});

describe("wrapChainError", () => {
  it("拼接说明与底层消息，并挂 cause", () => {
    const cause = new Error("nonce too low");
    const err = wrapChainError(cause, "submit 交易失败", { action: "submit", jobId: 3n });
    expect(err.message).toBe("submit 交易失败：nonce too low [action=submit jobId=3]");
    expect(err.cause).toBe(cause);
  });

  it("非 Error 抛出物也能包装", () => {
    expect(wrapChainError("plain", "调用失败").message).toBe("调用失败：plain");
  });

  it("底层消息里的私钥被屏蔽", () => {
    const err = wrapChainError(new Error(`leak ${FAKE_KEY}`), "调用失败", {}, [FAKE_KEY]);
    expect(err.message).toBe("调用失败：leak [REDACTED]");
  });
});
