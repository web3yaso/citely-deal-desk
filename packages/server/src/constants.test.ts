import { describe, expect, it } from "vitest";

import { AGENT_NAME, CAPABILITIES, DISCLAIMER, MODULE_JURISDICTIONS } from "./constants.js";

describe("constants", () => {
  it("免责声明逐字固定（对外只说这一句）", () => {
    expect(DISCLAIMER).toBe(
      "Results are compliance check statuses compiled from public legal sources. Not legal advice.",
    );
  });

  it("五个法域 Module 齐备", () => {
    expect(Object.keys(MODULE_JURISDICTIONS).sort()).toEqual([
      "ae-msb",
      "eu-msb",
      "sg-msb",
      "uk-msb",
      "us-msb",
    ]);
    expect(MODULE_JURISDICTIONS["ae-msb"]).toBe("United Arab Emirates");
  });

  it("能力条目 id 唯一且非空", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CAPABILITIES.every((capability) => capability.summary.length > 0)).toBe(true);
  });

  it("能力里显式写明放款条件不由 LLM 决定", () => {
    const summaries = CAPABILITIES.map((capability) => capability.summary).join(" ");
    expect(summaries).toContain("comes from rules");
    expect(summaries).toContain("not from an AI model");
  });

  it("服务名非空", () => {
    expect(AGENT_NAME.length).toBeGreaterThan(0);
  });
});
