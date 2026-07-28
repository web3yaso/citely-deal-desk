import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadRubric, parseRubric, parseSourceWhitelist, RubricSchemaError } from "./index.js";

/** 仓库根的 `rubrics/us-msb.json`（rubric 是 L1 资产，不在 packages/ 下）。 */
const US_MSB_PATH = fileURLToPath(new URL("../../../../rubrics/us-msb.json", import.meta.url));

const MINIMAL = {
  scenario: "s",
  version: "2026.07",
  last_verified_date: "2026-07-12",
  author: { name: "n", license: "l", wallet: "0x0" },
  royalty_bps: 500,
  items: [
    {
      id: "MT-01",
      question: "q",
      signals: ["a"],
      acceptance_criteria: ["b"],
      common_rejection_reasons: ["c"],
      source: "31 CFR § 1010.100(ff)",
      confidence_rule: "r",
    },
  ],
  verdict_states: ["confirmed_in_scope"],
};

describe("rubrics/us-msb.json", () => {
  it("能被 loadRubric 加载且通过 v2.2 §4.1 校验", () => {
    const loaded = loadRubric(US_MSB_PATH);
    expect(loaded.id).toBe("us-msb");
    expect(loaded.rubric.scenario).toContain("US MSB");
    expect(loaded.rubric.items.length).toBeGreaterThanOrEqual(1);
  });

  it("verdict_states 是 v2.2 的 3 态（5 态兜底由引擎补，不写进 rubric）", () => {
    const { rubric } = loadRubric(US_MSB_PATH);
    expect([...rubric.verdict_states].sort()).toEqual([
      "confirmed_exempt",
      "confirmed_in_scope",
      "gray_interpretive",
    ]);
  });

  it("每条 item 的 source 都能解析出非空白名单", () => {
    const { rubric } = loadRubric(US_MSB_PATH);
    for (const item of rubric.items) {
      const whitelist = parseSourceWhitelist(item.source);
      expect(whitelist.length).toBeGreaterThan(0);
      for (const ref of whitelist) expect(ref.trim()).toBe(ref);
    }
  });

  it("item id 唯一", () => {
    const { rubric } = loadRubric(US_MSB_PATH);
    const ids = rubric.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseRubric", () => {
  it("接受最小合法 rubric", () => {
    expect(parseRubric(MINIMAL).items[0]?.id).toBe("MT-01");
  });

  it.each([
    ["非对象", 42],
    ["缺 author", { ...MINIMAL, author: undefined }],
    ["royalty_bps 非整数", { ...MINIMAL, royalty_bps: 1.5 }],
    ["items 为空", { ...MINIMAL, items: [] }],
    ["verdict_states 含未知态", { ...MINIMAL, verdict_states: ["nope"] }],
    ["item 缺字段", { ...MINIMAL, items: [{ id: "X" }] }],
    [
      "item id 重复",
      { ...MINIMAL, items: [MINIMAL.items[0], MINIMAL.items[0]] },
    ],
  ])("拒绝 %s", (_name, raw) => {
    expect(() => parseRubric(raw)).toThrow(RubricSchemaError);
  });
});

describe("parseSourceWhitelist", () => {
  it("按 ' / ' 分割，不拆法条编号里的裸斜杠", () => {
    expect(parseSourceWhitelist("31 CFR § 1005.30(f)/(g) / FinCEN Ruling FIN-2008-R003")).toEqual([
      "31 CFR § 1005.30(f)/(g)",
      "FinCEN Ruling FIN-2008-R003",
    ]);
  });

  it("空串得到空白名单", () => {
    expect(parseSourceWhitelist("")).toEqual([]);
  });
});

describe("loadRubric", () => {
  it("非 JSON 文件抛 RubricSchemaError", () => {
    const notJson = fileURLToPath(new URL("../../../../rubrics/README.md", import.meta.url));
    expect(() => loadRubric(notJson)).toThrow(RubricSchemaError);
  });
});
