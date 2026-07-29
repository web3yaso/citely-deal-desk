import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { applySettlementPolicy } from "./policy.js";
import type { WalletSettlementPolicy } from "./policy.js";
import type { ObservedLeg, ObservedSa } from "./sa-view.js";

const PAYEE = `0x${"1".repeat(40)}` as Address;
const OTHER_PAYEE = `0x${"6".repeat(40)}` as Address;
const ISSUER = `0x${"2".repeat(40)}` as Address;
const CITELY_OPERATOR = `0x${"9".repeat(40)}` as Address;
const NOW = new Date("2026-07-28T00:00:00.000Z");

function leg(over: Partial<ObservedLeg> = {}): ObservedLeg {
  return {
    party: "payee-corp",
    payee: PAYEE,
    amountAtomic: 1_000_000n,
    condition: "PASS",
    basisCount: 2,
    ...over,
  };
}

function sa(over: Partial<ObservedSa> = {}): ObservedSa {
  return {
    caseId: "case-001",
    jobId: 12n,
    expiresAt: "2026-08-01T00:00:00.000Z",
    moduleRefs: ["us-msb@2026.07.1"],
    legs: [leg()],
    signer: ISSUER,
    ...over,
  };
}

function policy(over: Partial<WalletSettlementPolicy> = {}): WalletSettlementPolicy {
  return {
    trustedIssuers: [ISSUER],
    neverPayTo: [CITELY_OPERATOR],
    maxLegAmountAtomic: 5_000_000n,
    maxTotalAmountAtomic: 10_000_000n,
    requiredModuleRefs: ["us-msb@2026.07.1"],
    ...over,
  };
}

describe("applySettlementPolicy（钱包的自有预设策略）", () => {
  it("全条件满足 → 钱包决定执行，付款目标是 SA 里的收款方", () => {
    const decision = applySettlementPolicy({
      sa: sa(),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.payments).toEqual([{ party: "payee-corp", to: PAYEE, amountAtomic: 1_000_000n }]);
  });

  it("出具方不在钱包信任名单 → 不执行（信任名单是钱包的，不是 Citely 给的）", () => {
    const decision = applySettlementPolicy({
      sa: sa(),
      policy: policy({ trustedIssuers: [] }),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.payments).toEqual([]);
    expect(decision.blockers.map((b) => b.code)).toContain("issuer_not_trusted");
  });

  it("SA 已过期 → 不执行", () => {
    const decision = applySettlementPolicy({
      sa: sa({ expiresAt: "2026-07-27T00:00:00.000Z" }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.blockers.map((b) => b.code)).toContain("sa_expired");
  });

  it("SA 绑定的 jobId 不是本钱包资助的那一单 → 不执行", () => {
    const decision = applySettlementPolicy({
      sa: sa(),
      policy: policy(),
      fundedJobId: 99n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.blockers.map((b) => b.code)).toContain("job_id_mismatch");
  });

  it("要求的 Module 未被引用 → 不执行", () => {
    const decision = applySettlementPolicy({
      sa: sa({ moduleRefs: ["us-msb@2025.01.1"] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.blockers.map((b) => b.code)).toContain("required_module_missing");
  });

  // 不变量 3 的客户侧把关：客户资金永不进我方地址。
  it("收款方是 Citely 地址 → 整单中止，一分钱不付", () => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg({ payee: CITELY_OPERATOR })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.payments).toEqual([]);
    expect(decision.blockers.map((b) => b.code)).toContain("payee_blacklisted");
  });

  it("一条腿命中黑名单时其余合法腿也不放行（整单红线）", () => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg(), leg({ party: "other", payee: CITELY_OPERATOR })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.payments).toEqual([]);
  });

  it.each([
    ["HOLD", "condition_hold"],
    ["ESCALATE", "condition_escalate"],
  ] as const)("condition=%s 的腿被扣住，不进付款计划", (condition, code) => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg(), leg({ party: "held", condition })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(true);
    expect(decision.payments.map((p) => p.party)).toEqual(["payee-corp"]);
    // 扣住理由要能精确定位到具体某条腿，报告时才说得清"为什么没付"。
    expect(decision.withheld).toEqual([
      { legIndex: 1, party: "held", condition, code, detail: "held" },
    ]);
  });

  it("钱包看不懂的 condition 一律扣住（看不懂不等于放行）", () => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg({ condition: null })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.withheld.map((w) => w.code)).toEqual(["condition_unrecognized"]);
  });

  it("无依据的腿被扣住", () => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg({ basisCount: 0 })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.withheld.map((w) => w.code)).toEqual(["leg_without_basis"]);
  });

  it("单腿金额超上限 → 整单中止", () => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg({ amountAtomic: 5_000_001n })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.blockers.map((b) => b.code)).toContain("leg_amount_over_cap");
  });

  it("全单金额超上限 → 整单中止", () => {
    const decision = applySettlementPolicy({
      sa: sa({
        legs: [
          leg({ party: "a", amountAtomic: 4_000_000n }),
          leg({ party: "b", payee: OTHER_PAYEE, amountAtomic: 4_000_000n }),
          leg({ party: "c", payee: OTHER_PAYEE, amountAtomic: 4_000_000n }),
        ],
      }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.blockers.map((b) => b.code)).toContain("total_amount_over_cap");
  });

  it("没有任何可执行的腿 → 不执行", () => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg({ condition: "HOLD" })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.payments).toEqual([]);
  });

  // 真链实测就是这个形态：Module 给 HOLD → 腿被扣住 → 钱包不放款，
  // 但整单红线为空（SA 本身完全可信）。报告必须能把这两件事分开讲清楚。
  it("全部腿被扣住时 execute=false 而 blockers 为空——两者不是同一个概念", () => {
    const decision = applySettlementPolicy({
      sa: sa({ legs: [leg({ condition: "HOLD" })] }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.blockers).toEqual([]);
    // "为什么没付款"的答案必须在 withheld 里，不能只剩一个布尔值。
    expect(decision.withheld).toHaveLength(1);
    expect(decision.withheld[0]?.code).toBe("condition_hold");
    expect(decision.withheld[0]?.condition).toBe("HOLD");
    expect(decision.withheld[0]?.legIndex).toBe(0);
  });

  it("扣住理由带下标，多条腿时能定位到具体哪一条", () => {
    const decision = applySettlementPolicy({
      sa: sa({
        legs: [
          leg({ party: "a", condition: "HOLD" }),
          leg({ party: "b", payee: OTHER_PAYEE }),
          leg({ party: "c", payee: OTHER_PAYEE, condition: "ESCALATE" }),
        ],
      }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.withheld.map((w) => [w.legIndex, w.party, w.condition])).toEqual([
      [0, "a", "HOLD"],
      [2, "c", "ESCALATE"],
    ]);
    expect(decision.payments.map((p) => p.party)).toEqual(["b"]);
  });

  it("有效期不可解析 → 不执行（不给「解析失败就当没过期」留后门）", () => {
    const decision = applySettlementPolicy({
      sa: sa({ expiresAt: "next tuesday" }),
      policy: policy(),
      fundedJobId: 12n,
      now: NOW,
    });
    expect(decision.execute).toBe(false);
    expect(decision.blockers.map((b) => b.code)).toContain("expiry_unparseable");
  });
});
