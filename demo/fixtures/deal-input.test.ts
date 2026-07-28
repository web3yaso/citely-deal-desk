import { sanitizeMaterial } from "@citely/engine/sandbox";
import { canonicalJson } from "@citely/engine/util/canonical";
import { describe, expect, it } from "vitest";

import {
  CLEAN_DEAL_INPUT,
  INJECTED_DEAL_INPUT,
  INJECTED_FIELD_PATH,
  INJECTION_PAYLOAD,
} from "./deal-input.js";

/** 按 `a.b.c` 路径取值。 */
function at(deal: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (typeof acc !== "object" || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, deal);
}

/** 把某个路径上的值抹成常量，用来做「其余字段是否逐字相同」的对比。 */
function blank(deal: unknown, path: string): unknown {
  const clone = JSON.parse(JSON.stringify(deal)) as Record<string, unknown>;
  const keys = path.split(".");
  const last = keys.pop();
  if (last === undefined) throw new Error("path must not be empty");
  let cursor: Record<string, unknown> = clone;
  for (const key of keys) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[last] = "<blanked>";
  return clone;
}

describe("合成案件 fixture", () => {
  it("干净版不含注入载荷", () => {
    expect(canonicalJson(CLEAN_DEAL_INPUT)).not.toContain(INJECTION_PAYLOAD);
  });

  it("注入版把载荷埋在约定的自由文本字段里", () => {
    expect(at(INJECTED_DEAL_INPUT, INJECTED_FIELD_PATH)).toContain(INJECTION_PAYLOAD);
  });

  // A3 断言（engine 侧）成立的前提：差异面必须只有这一个字段。
  it("两版除该字段外逐字节相同", () => {
    expect(canonicalJson(blank(INJECTED_DEAL_INPUT, INJECTED_FIELD_PATH))).toBe(
      canonicalJson(blank(CLEAN_DEAL_INPUT, INJECTED_FIELD_PATH)),
    );
  });

  it("两版整体不相同（防止 fixture 退化成同一份）", () => {
    expect(canonicalJson(INJECTED_DEAL_INPUT)).not.toBe(canonicalJson(CLEAN_DEAL_INPUT));
  });

  it("fixture 不可变：多次读取得到同一份内容", () => {
    expect(canonicalJson(CLEAN_DEAL_INPUT)).toBe(canonicalJson(CLEAN_DEAL_INPUT));
  });
});

describe("沙箱对 fixture 的确定性检测（防止 fixture 变成无效回归）", () => {
  it("注入版被沙箱标记 injection_attempt", () => {
    const facts = sanitizeMaterial({ fields: INJECTED_DEAL_INPUT.evidence });
    expect(facts.detected_flags).toContain("injection_attempt");
    expect(facts.detections.map((d) => d.field)).toContain("compliance_note");
  });

  it("干净版不产生任何注入标记（无误报）", () => {
    const facts = sanitizeMaterial({ fields: CLEAN_DEAL_INPUT.evidence });
    expect(facts.detected_flags).toEqual([]);
    expect(facts.detections).toEqual([]);
  });

  it("沙箱只留哈希，不回显注入原文", () => {
    const facts = sanitizeMaterial({ fields: INJECTED_DEAL_INPUT.evidence });
    expect(JSON.stringify(facts.detections)).not.toContain(INJECTION_PAYLOAD);
  });
});
