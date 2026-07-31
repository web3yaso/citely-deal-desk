import { describe, expect, it } from "vitest";

import { AGENT_NAME, CAPABILITIES, DISCLAIMER, MODULE_JURISDICTIONS } from "./constants.js";

describe("constants", () => {
  it("免责声明逐字固定（对外只说这一句）", () => {
    expect(DISCLAIMER).toBe("输出为基于公开法源整理的检查项状态，不构成法律意见。");
  });

  it("四个法域 Module 齐备", () => {
    expect(Object.keys(MODULE_JURISDICTIONS).sort()).toEqual([
      "eu-msb",
      "sg-msb",
      "uk-msb",
      "us-msb",
    ]);
  });

  it("能力条目 id 唯一且非空", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CAPABILITIES.every((capability) => capability.summary.length > 0)).toBe(true);
  });

  it("能力里显式写明放款条件不由 LLM 决定", () => {
    const summaries = CAPABILITIES.map((capability) => capability.summary).join(" ");
    expect(summaries).toContain("确定性规则");
    expect(summaries).toContain("语言模型");
  });

  it("服务名非空", () => {
    expect(AGENT_NAME.length).toBeGreaterThan(0);
  });
});
