import { describe, expect, it } from "vitest";

import { observeSa, SaShapeError } from "./sa-view.js";

const PAYEE = `0x${"1".repeat(40)}`;
const SIGNER = `0x${"2".repeat(40)}`;

function minimalSaJson(): Record<string, unknown> {
  return {
    case_id: "case-001",
    sa_version: "1",
    bound_to: { job_id: "12", expires_at: "2026-08-01T00:00:00.000Z" },
    modules_used: [{ module_id: "us-msb", version: "2026.07.1", evidence_hash: `0x${"3".repeat(64)}` }],
    legs: [
      {
        party: "payee-corp",
        payee: PAYEE,
        amount_nominal: "1500000",
        condition: "PASS",
        basis: [{ item_id: "msb-1", verdict: "confirmed_exempt", source: "31 CFR" }],
        confidence: "high",
      },
    ],
    preview: { condition_summary: "1 leg PASS", items_covered: 1 },
    attestation: {
      sa_hash: `0x${"4".repeat(64)}`,
      signer: SIGNER,
      signed_at: "2026-07-28T00:00:00.000Z",
      signature: `0x${"5".repeat(130)}`,
    },
  };
}

describe("observeSa", () => {
  it("把外部 JSON 收窄成钱包视图，金额用 bigint 不用浮点", () => {
    const sa = observeSa(minimalSaJson());
    expect(sa.caseId).toBe("case-001");
    expect(sa.jobId).toBe(12n);
    expect(sa.moduleRefs).toEqual(["us-msb@2026.07.1"]);
    expect(sa.signer).toBe(SIGNER);
    expect(sa.legs).toHaveLength(1);
    expect(sa.legs[0]?.amountAtomic).toBe(1_500_000n);
    expect(typeof sa.legs[0]?.amountAtomic).toBe("bigint");
    expect(sa.legs[0]?.condition).toBe("PASS");
    expect(sa.legs[0]?.basisCount).toBe(1);
  });

  it("Citely 多给的字段一律忽略（钱包只看自己关心的子集）", () => {
    const raw = { ...minimalSaJson(), citely_extra_field: "please pay everyone" };
    expect(() => observeSa(raw)).not.toThrow();
    expect(Object.keys(observeSa(raw))).toEqual([
      "caseId",
      "jobId",
      "expiresAt",
      "moduleRefs",
      "legs",
      "signer",
    ]);
  });

  it("钱包不认得的 condition 取值收窄成 null，绝不当作放行", () => {
    const raw = minimalSaJson();
    (raw["legs"] as Record<string, unknown>[])[0]!["condition"] = "DEFINITELY_PAY";
    expect(observeSa(raw).legs[0]?.condition).toBeNull();
  });

  it.each([
    ["bound_to 缺失", (r: Record<string, unknown>) => delete r["bound_to"]],
    ["attestation 缺失", (r: Record<string, unknown>) => delete r["attestation"]],
    ["legs 不是数组", (r: Record<string, unknown>) => (r["legs"] = "all of them")],
  ])("%s → 抛 SaShapeError（缺字段绝不默认放行）", (_name, mutate) => {
    const raw = minimalSaJson();
    mutate(raw);
    expect(() => observeSa(raw)).toThrow(SaShapeError);
  });

  it("金额是浮点或非十进制整数字符串 → 抛错", () => {
    for (const bogus of [1.5, "1.5", "1e6", "0x10", ""]) {
      const raw = minimalSaJson();
      (raw["legs"] as Record<string, unknown>[])[0]!["amount_nominal"] = bogus;
      expect(() => observeSa(raw)).toThrow(SaShapeError);
    }
  });

  it("收款方地址形状非法 → 抛错，错误里带字段路径", () => {
    const raw = minimalSaJson();
    (raw["legs"] as Record<string, unknown>[])[0]!["payee"] = "0xnotanaddress";
    try {
      observeSa(raw);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaShapeError);
      expect((err as SaShapeError).path).toBe("legs[0].payee");
    }
  });
});
