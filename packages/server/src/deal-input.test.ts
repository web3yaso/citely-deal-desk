import { describe, expect, it } from "vitest";

import { parseDealInput } from "./deal-input.js";

/** 去掉一个字段的浅拷贝。比解构丢弃更直白，也不触发未使用变量规则。 */
function without<T extends object>(source: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...source };
  delete copy[key];
  return copy;
}


const VALID = {
  deal_id: "case-001",
  parties: [
    { role: "payer", country: "US", state: "NY" },
    { role: "payee", country: "GB" },
  ],
  activity: "money_transmission",
  amount_usdc: 12_500,
  monthly_volume_usdc: 90_000,
  evidence: { invoice_ref: "INV-1" },
};

function issuePaths(raw: unknown): readonly string[] {
  const result = parseDealInput(raw);
  if (result.ok) throw new Error("预期校验失败，实际通过");
  return result.issues.map((issue) => issue.path);
}

describe("parseDealInput", () => {
  it("接受合法请求并逐字段重建", () => {
    const result = parseDealInput(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deal_id).toBe("case-001");
    expect(result.value.parties).toHaveLength(2);
    expect(result.value.parties[0]).toEqual({ role: "payer", country: "US", state: "NY" });
    expect(result.value.activity).toBe("money_transmission");
  });

  it("剔除未声明的多余字段，不让它流进下游", () => {
    const result = parseDealInput({ ...VALID, injected_field: "drop me" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value)).not.toContain("injected_field");
  });

  it("省略可选字段时不产生 undefined 键（exactOptionalPropertyTypes）", () => {
    const result = parseDealInput(without(VALID, "monthly_volume_usdc"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("monthly_volume_usdc" in result.value).toBe(false);
    expect("state" in result.value.parties[1]!).toBe(false);
  });

  it("接受 monthly_volume_usdc 为 null", () => {
    const result = parseDealInput({ ...VALID, monthly_volume_usdc: null });
    expect(result.ok).toBe(true);
  });

  it("非对象请求体被拒", () => {
    expect(issuePaths("not an object")).toEqual([""]);
    expect(issuePaths([])).toEqual([""]);
    expect(issuePaths(null)).toEqual([""]);
  });

  it("deal_id 缺失或超长被拒", () => {
    expect(issuePaths({ ...VALID, deal_id: "" })).toContain("deal_id");
    expect(issuePaths({ ...VALID, deal_id: "x".repeat(129) })).toContain("deal_id");
  });

  it("parties 为空或过多被拒", () => {
    expect(issuePaths({ ...VALID, parties: [] })).toContain("parties");
    const many = Array.from({ length: 33 }, () => ({ role: "payer", country: "US" }));
    expect(issuePaths({ ...VALID, parties: many })).toContain("parties");
  });

  it("party 字段错误定位到具体下标", () => {
    const paths = issuePaths({
      ...VALID,
      parties: [{ role: "payer", country: "US" }, { role: "bogus", country: "usa" }],
    });
    expect(paths).toContain("parties.1.role");
    expect(paths).toContain("parties.1.country");
  });

  it("非法 activity 被拒", () => {
    expect(issuePaths({ ...VALID, activity: "smuggling" })).toContain("activity");
  });

  it("金额必须为正的有限数", () => {
    expect(issuePaths({ ...VALID, amount_usdc: 0 })).toContain("amount_usdc");
    expect(issuePaths({ ...VALID, amount_usdc: -1 })).toContain("amount_usdc");
    expect(issuePaths({ ...VALID, amount_usdc: Number.NaN })).toContain("amount_usdc");
    expect(issuePaths({ ...VALID, amount_usdc: "12500" })).toContain("amount_usdc");
  });

  it("monthly_volume_usdc 非法值被拒", () => {
    expect(issuePaths({ ...VALID, monthly_volume_usdc: -1 })).toContain("monthly_volume_usdc");
    expect(issuePaths({ ...VALID, monthly_volume_usdc: "many" })).toContain(
      "monthly_volume_usdc",
    );
  });

  it("evidence 必须是对象", () => {
    expect(issuePaths({ ...VALID, evidence: "text" })).toContain("evidence");
    expect(issuePaths({ ...VALID, evidence: [] })).toContain("evidence");
  });

  it("一次报出全部问题，不是只报第一个", () => {
    const paths = issuePaths({ deal_id: "", parties: [], activity: "x", evidence: 1 });
    expect(paths.length).toBeGreaterThanOrEqual(4);
  });
});
