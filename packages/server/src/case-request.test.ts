import { describe, expect, it } from "vitest";

import { parseCaseRequest } from "./case-request.js";

/** 去掉一个字段的浅拷贝。比解构丢弃更直白，也不触发未使用变量规则。 */
function without<T extends object>(source: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...source };
  delete copy[key];
  return copy;
}


const VALID = {
  deal_id: "case-001",
  parties: [
    { role: "payer", country: "US" },
    { role: "payee", country: "GB" },
  ],
  activity: "money_transmission",
  amount_usdc: 12_500,
  evidence: {},
  settlement: {
    party: "uk_service_agent",
    payee: "0x000000000000000000000000000000000000bEEF",
    amount_usdc: "12500.00",
  },
  expires_at: "2026-12-31T00:00:00.000Z",
};

function issuePaths(raw: unknown): readonly string[] {
  const result = parseCaseRequest(raw);
  if (result.ok) throw new Error("预期校验失败，实际通过");
  return result.issues.map((issue) => issue.path);
}

describe("parseCaseRequest", () => {
  it("接受合法请求", () => {
    const result = parseCaseRequest(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deal.deal_id).toBe("case-001");
    expect(result.value.settlement.party).toBe("uk_service_agent");
    expect(result.value.settlement.payee).toBe("0x000000000000000000000000000000000000bEEF");
    expect(result.value.expiresAt.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("金额按 6 位小数换算成最小单位", () => {
    const result = parseCaseRequest(VALID);
    if (!result.ok) throw new Error("应当通过");
    expect(result.value.settlement.amountAtomic).toBe(12_500_000_000n);
  });

  it("金额小数位精确保留，不走浮点", () => {
    const result = parseCaseRequest({
      ...VALID,
      settlement: { ...VALID.settlement, amount_usdc: "0.000001" },
    });
    if (!result.ok) throw new Error("应当通过");
    expect(result.value.settlement.amountAtomic).toBe(1n);
  });

  it("非对象请求体被拒", () => {
    expect(issuePaths("x")).toEqual([""]);
  });

  it("缺 settlement 被拒（没有收款方就产不出 SA）", () => {
    expect(issuePaths(without(VALID, "settlement"))).toContain("settlement");
  });

  it("收款方地址形状非法被拒", () => {
    expect(
      issuePaths({ ...VALID, settlement: { ...VALID.settlement, payee: "0x1234" } }),
    ).toContain("settlement.payee");
  });

  it("腿标识形状非法被拒", () => {
    expect(
      issuePaths({ ...VALID, settlement: { ...VALID.settlement, party: "bad party!" } }),
    ).toContain("settlement.party");
  });

  it("金额是 JSON number 时被拒（浮点会失真）", () => {
    expect(
      issuePaths({ ...VALID, settlement: { ...VALID.settlement, amount_usdc: 12_500 } }),
    ).toContain("settlement.amount_usdc");
  });

  it("金额小数位过多被拒", () => {
    expect(
      issuePaths({ ...VALID, settlement: { ...VALID.settlement, amount_usdc: "1.0000001" } }),
    ).toContain("settlement.amount_usdc");
  });

  it("缺 expires_at 被拒（服务端不替调用方猜到期时刻）", () => {
    expect(issuePaths(without(VALID, "expires_at"))).toContain("expires_at");
  });

  it("expires_at 非法时刻被拒", () => {
    expect(issuePaths({ ...VALID, expires_at: "not a date" })).toContain("expires_at");
  });

  it("DealInput 部分的错误一并报出", () => {
    const paths = issuePaths({ ...VALID, deal_id: "", activity: "bogus" });
    expect(paths).toContain("deal_id");
    expect(paths).toContain("activity");
  });

  it("DealInput 与 settlement 的错误同时报出，不是只报一半", () => {
    const paths = issuePaths({ ...VALID, deal_id: "", settlement: {}, expires_at: 1 });
    expect(paths).toContain("deal_id");
    expect(paths).toContain("settlement.payee");
    expect(paths).toContain("expires_at");
  });
});
