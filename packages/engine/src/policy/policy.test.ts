import type { SettlementConstraints } from "@citely/chain/types";
import { describe, expect, it } from "vitest";

import type { Verdict } from "../adjudicator/schema.js";
import { VERDICTS } from "../adjudicator/schema.js";
import type { SaCondition } from "../sa/types.js";
import { conditionFromModule, deriveCondition, maxSeverity } from "./condition.js";
import type { PolicyModuleInput } from "./condition.js";
import { confidenceFromVerdict, deriveLegConfidence, worseConfidence } from "./confidence.js";
import { buildLeg, buildLegs, buildPreview, countConditions } from "./legs.js";
import type { PolicyLegInput } from "./legs.js";

function constraints(over: Partial<SettlementConstraints> = {}): SettlementConstraints {
  return {
    module: "us-msb",
    module_version: "2026.07.1",
    deal_id: "DEAL-1",
    valid_until: "2026-08-01T00:00:00Z",
    blocked_check_ids: [],
    escalated_check_ids: [],
    evidence_hash: "ab".repeat(32),
    ...over,
  };
}

function moduleInput(over: Partial<PolicyModuleInput> = {}): PolicyModuleInput {
  return { overall: "PASS", settlement_constraints: constraints(), ...over };
}

describe("maxSeverity", () => {
  it("PASS < HOLD < ESCALATE，永远取更严的一档", () => {
    expect(maxSeverity("PASS", "HOLD")).toBe("HOLD");
    expect(maxSeverity("HOLD", "PASS")).toBe("HOLD");
    expect(maxSeverity("HOLD", "ESCALATE")).toBe("ESCALATE");
    expect(maxSeverity("ESCALATE", "PASS")).toBe("ESCALATE");
    expect(maxSeverity("PASS", "PASS")).toBe("PASS");
  });
});

describe("conditionFromModule", () => {
  it("两个 id 列表都空且 overall=PASS → PASS", () => {
    expect(conditionFromModule(moduleInput())).toBe("PASS");
  });

  it("blocked_check_ids 非空 → HOLD", () => {
    const input = moduleInput({ settlement_constraints: constraints({ blocked_check_ids: ["MT-02"] }) });
    expect(conditionFromModule(input)).toBe("HOLD");
  });

  it("escalated_check_ids 非空 → ESCALATE（压过 blocked）", () => {
    const input = moduleInput({
      settlement_constraints: constraints({
        blocked_check_ids: ["MT-02"],
        escalated_check_ids: ["MT-07"],
      }),
    });
    expect(conditionFromModule(input)).toBe("ESCALATE");
  });

  it("id 列表为空但 overall 更严时取 overall（单调收紧）", () => {
    expect(conditionFromModule(moduleInput({ overall: "HOLD" }))).toBe("HOLD");
    expect(conditionFromModule(moduleInput({ overall: "ESCALATE" }))).toBe("ESCALATE");
  });

  it("overall 比 id 列表宽松时不放宽", () => {
    const input = moduleInput({
      overall: "PASS",
      settlement_constraints: constraints({ escalated_check_ids: ["MT-07"] }),
    });
    expect(conditionFromModule(input)).toBe("ESCALATE");
  });
});

describe("deriveCondition", () => {
  it("空输入 → ESCALATE（无依据不放行）", () => {
    expect(deriveCondition([])).toBe("ESCALATE");
  });

  it("多 Module 取最严的一档", () => {
    expect(deriveCondition([moduleInput(), moduleInput()])).toBe("PASS");
    expect(deriveCondition([moduleInput(), moduleInput({ overall: "HOLD" })])).toBe("HOLD");
    expect(
      deriveCondition([moduleInput({ overall: "HOLD" }), moduleInput({ overall: "ESCALATE" })]),
    ).toBe("ESCALATE");
  });

  it("顺序不影响结果", () => {
    const a = moduleInput({ overall: "ESCALATE" });
    const b = moduleInput({ overall: "HOLD" });
    expect(deriveCondition([a, b])).toBe(deriveCondition([b, a]));
  });
});

describe("不变量 2：condition 与判定器 verdict 无关", () => {
  it("同一 Module 结果下，任何 verdict 组合都算出同一个 condition", () => {
    const modules = [moduleInput({ overall: "HOLD" })];
    const baseline = deriveCondition(modules);
    for (const verdict of VERDICTS) {
      const leg = buildLeg({
        party: "p",
        payee: "0x1111111111111111111111111111111111111111",
        amount_nominal: "1",
        modules,
        basis: [{ item_id: "MT-01", verdict, source: "31 CFR § 1010.100(ff)" }],
      });
      expect(leg.condition).toBe(baseline);
    }
  });
});

describe("confidenceFromVerdict", () => {
  const cases: readonly [Verdict, string][] = [
    ["confirmed_in_scope", "high"],
    ["confirmed_exempt", "high"],
    ["gray_data", "gray_data_resolved"],
    ["gray_interpretive", "gray_interpretive"],
    ["unverifiable", "gray_interpretive"],
  ];
  it.each(cases)("%s → %s", (verdict, expected) => {
    expect(confidenceFromVerdict(verdict)).toBe(expected);
  });

  it("5 态全覆盖，没有漏映射", () => {
    for (const verdict of VERDICTS) {
      expect(["high", "gray_data_resolved", "gray_interpretive"]).toContain(
        confidenceFromVerdict(verdict),
      );
    }
  });
});

describe("worseConfidence / deriveLegConfidence", () => {
  it("取成色更差的一个", () => {
    expect(worseConfidence("high", "gray_data_resolved")).toBe("gray_data_resolved");
    expect(worseConfidence("gray_interpretive", "high")).toBe("gray_interpretive");
    expect(worseConfidence("high", "high")).toBe("high");
  });

  it("空依据 → gray_interpretive", () => {
    expect(deriveLegConfidence([])).toBe("gray_interpretive");
  });

  it("全 confirmed → high；混入 gray_data → gray_data_resolved；混入 unverifiable → gray_interpretive", () => {
    expect(deriveLegConfidence(["confirmed_exempt", "confirmed_in_scope"])).toBe("high");
    expect(deriveLegConfidence(["confirmed_exempt", "gray_data"])).toBe("gray_data_resolved");
    expect(deriveLegConfidence(["confirmed_exempt", "gray_data", "unverifiable"])).toBe(
      "gray_interpretive",
    );
  });
});

describe("buildLeg", () => {
  const input: PolicyLegInput = {
    party: "uk_service_agent",
    payee: "0x1111111111111111111111111111111111111111",
    amount_nominal: "1000000",
    modules: [moduleInput()],
    basis: [{ item_id: "MT-01", verdict: "confirmed_exempt", source: "31 CFR § 1010.100(ff)" }],
  };

  it("商务字段逐字搬运，condition/confidence 由推导得出", () => {
    expect(buildLeg(input)).toEqual({
      party: "uk_service_agent",
      payee: "0x1111111111111111111111111111111111111111",
      amount_nominal: "1000000",
      condition: "PASS",
      basis: [{ item_id: "MT-01", verdict: "confirmed_exempt", source: "31 CFR § 1010.100(ff)" }],
      confidence: "high",
    });
  });

  it("不带 escalation 时该键不存在（不是 undefined）", () => {
    expect("escalation" in buildLeg(input)).toBe(false);
  });

  it("带 escalation 时原样保留", () => {
    const escalation = {
      review_job_template: { kind: "review" },
      briefing_pack_hash: `0x${"cd".repeat(32)}` as const,
    };
    expect(buildLeg({ ...input, escalation }).escalation).toEqual(escalation);
  });

  it("buildLegs 保留顺序", () => {
    const legs = buildLegs([input, { ...input, party: "us_payer" }]);
    expect(legs.map((l) => l.party)).toEqual(["uk_service_agent", "us_payer"]);
  });
});

describe("countConditions / buildPreview", () => {
  const legs: readonly { condition: SaCondition }[] = [
    { condition: "PASS" },
    { condition: "PASS" },
    { condition: "PASS" },
    { condition: "HOLD" },
    { condition: "ESCALATE" },
  ];

  it("统计三态腿数", () => {
    expect(countConditions(legs)).toEqual({ PASS: 3, HOLD: 1, ESCALATE: 1 });
  });

  it("condition_summary 措辞与 v2.2 §4.2 示例一致", () => {
    expect(buildPreview(legs, 18)).toEqual({
      condition_summary: "3 PASS / 1 HOLD / 1 ESCALATE",
      items_covered: 18,
    });
  });

  it("空腿也给出完整摘要", () => {
    expect(buildPreview([], 0).condition_summary).toBe("0 PASS / 0 HOLD / 0 ESCALATE");
  });
});
