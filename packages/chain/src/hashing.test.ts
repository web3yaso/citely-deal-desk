import { describe, expect, it } from "vitest";

import { bytes32FromText } from "./hashing.js";

describe("bytes32FromText", () => {
  it("产出 32 字节十六进制", () => {
    expect(bytes32FromText("case-1:deliverable")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("同输入同输出，异输入异输出", () => {
    expect(bytes32FromText("a")).toBe(bytes32FromText("a"));
    expect(bytes32FromText("a")).not.toBe(bytes32FromText("b"));
  });

  it("与 keccak256 的已知向量一致（空串）", () => {
    expect(bytes32FromText("")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });
});
