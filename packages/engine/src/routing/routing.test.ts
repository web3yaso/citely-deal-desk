/**
 * 五出口路由 + 采购三约束的测试（v2.3 §2.2 / §2.1b）。
 * 每个出口一条端到端断言（路由 → 链上动作 → 由谁执行）。
 */

import { describe, expect, it } from "vitest";

import { deriveCondition, type PolicyModuleInput } from "../policy/index.js";
import { usdc6, usdc6FromDecimal } from "../util/usdc6.js";
import {
  exitForGrayType,
  itemsNeedingEscalation,
  itemsNeedingProcurement,
  routeExit,
} from "./exits.js";
import type { AdjudicationSummary, RoutingInput } from "./exits.js";
import {
  checkProcurement,
  isProcurementSuccessful,
  PROCUREMENT_MAX_ATTEMPTS,
  shouldRetryProcurement,
} from "./procurement.js";
import type { ProcurementLimits } from "./procurement.js";

function input(over: Partial<RoutingInput> = {}): RoutingInput {
  return { intake: "ok", expired: false, adjudications: [], ...over };
}

const CONFIRMED: AdjudicationSummary = { item_id: "MT-01", verdict: "confirmed_in_scope" };
const DATA_GAP: AdjudicationSummary = {
  item_id: "MT-02",
  verdict: "gray_data",
  gray_type: "data",
};
const INTERPRETIVE: AdjudicationSummary = {
  item_id: "MT-03",
  verdict: "gray_interpretive",
  gray_type: "interpretive",
};

describe("gray_type 是出口 3 与 4 的唯一分支依据（§2.2 末句）", () => {
  it.each([
    ["data", "data_gap"],
    ["interpretive", "interpretive_gray"],
  ] as const)("gray_type=%s → %s", (grayType, expected) => {
    expect(exitForGrayType(grayType)).toBe(expected);
  });

  it("非灰色判定不走这两个出口", () => {
    expect(exitForGrayType(undefined)).toBeNull();
  });
});

describe("出口 1：受理失败 → 验证器在 Funded 态 reject", () => {
  it.each(["unparsable", "out_of_rubric_scope"] as const)("intake=%s", (intake) => {
    const decision = routeExit(input({ intake }));
    expect(decision.exit).toBe("intake_failed");
    expect(decision.chainAction).toBe("reject");
    expect(decision.actor).toBe("verifier");
  });

  it("受理失败时不看判定结果（它们要么不存在要么不可信）", () => {
    const decision = routeExit(
      input({ intake: "unparsable", adjudications: [CONFIRMED, INTERPRETIVE] }),
    );
    expect(decision.exit).toBe("intake_failed");
  });
});

describe("出口 2：高置信 → operator submit", () => {
  it("全部落定且无缺口", () => {
    const decision = routeExit(input({ adjudications: [CONFIRMED, CONFIRMED] }));
    expect(decision.exit).toBe("high_confidence");
    expect(decision.chainAction).toBe("submit");
    expect(decision.actor).toBe("operator");
  });

  it("confirmed_exempt 与 confirmed_in_scope 同样走出口 2（置信度≠业务风险）", () => {
    const exempt: AdjudicationSummary = { item_id: "MT-04", verdict: "confirmed_exempt" };
    expect(routeExit(input({ adjudications: [exempt] })).exit).toBe("high_confidence");
  });
});

describe("出口 3：数据缺口 → 先采购，不产生链上动作", () => {
  it("有开放缺口时路由到 data_gap 且 chainAction=none", () => {
    const decision = routeExit(input({ adjudications: [CONFIRMED, DATA_GAP] }));
    expect(decision.exit).toBe("data_gap");
    expect(decision.chainAction).toBe("none");
    expect(decision.actor).toBe("none");
  });

  it("列出需要采购的判定项", () => {
    const routing = input({ adjudications: [CONFIRMED, DATA_GAP, INTERPRETIVE] });
    expect(itemsNeedingProcurement(routing).map((i) => i.item_id)).toEqual(["MT-02"]);
  });

  it("**数据缺口优先于解释性 gray**——先把能买的买了再定终局", () => {
    const decision = routeExit(input({ adjudications: [DATA_GAP, INTERPRETIVE] }));
    expect(decision.exit).toBe("data_gap");
  });

  it("买过仍未消解的缺口不再算开放，避免死循环（归入出口 2 或 4）", () => {
    const exhausted: AdjudicationSummary = { ...DATA_GAP, procurementExhausted: true };
    expect(routeExit(input({ adjudications: [exhausted] })).exit).toBe("high_confidence");
    expect(routeExit(input({ adjudications: [exhausted, INTERPRETIVE] })).exit).toBe(
      "interpretive_gray",
    );
  });
});

describe("出口 4：解释性 gray → ESCALATE 随 SA submit", () => {
  it("路由到 interpretive_gray，仍由 operator submit", () => {
    const decision = routeExit(input({ adjudications: [CONFIRMED, INTERPRETIVE] }));
    expect(decision.exit).toBe("interpretive_gray");
    expect(decision.chainAction).toBe("submit");
    expect(decision.actor).toBe("operator");
  });

  it("列出需要升级的判定项（据此生成卷宗与 Review Job 模板）", () => {
    const routing = input({ adjudications: [CONFIRMED, INTERPRETIVE] });
    expect(itemsNeedingEscalation(routing).map((i) => i.item_id)).toEqual(["MT-03"]);
  });
});

describe("出口 5：超时 → client claimRefund，压倒一切", () => {
  it("expired 时无论其他条件如何都走超时出口", () => {
    const decision = routeExit(
      input({ expired: true, intake: "unparsable", adjudications: [DATA_GAP, INTERPRETIVE] }),
    );
    expect(decision.exit).toBe("timeout");
    expect(decision.chainAction).toBe("claimRefund");
    expect(decision.actor).toBe("client");
  });

  it("理由里写明它是 permissionless 场景（过期后谁都能触发退款）", () => {
    expect(routeExit(input({ expired: true })).reason).toContain("expiredAt");
  });
});

describe("五个出口互斥且穷尽", () => {
  it("任何输入都恰好落到一个出口", () => {
    const cases: readonly RoutingInput[] = [
      input(),
      input({ adjudications: [CONFIRMED] }),
      input({ adjudications: [DATA_GAP] }),
      input({ adjudications: [INTERPRETIVE] }),
      input({ intake: "unparsable" }),
      input({ expired: true }),
    ];
    const exits = cases.map((c) => routeExit(c).exit);
    expect(new Set(exits)).toEqual(
      new Set([
        "high_confidence",
        "data_gap",
        "interpretive_gray",
        "intake_failed",
        "timeout",
      ]),
    );
  });

  it("空判定集且受理正常 → 出口 2（没有缺口就是没有缺口）", () => {
    expect(routeExit(input()).exit).toBe("high_confidence");
  });
});

// ───────────────────────── 采购三约束（§2.1b） ─────────────────────────

const ENDPOINT = "https://msb-agent-production-769d.up.railway.app/modules/us-msb/check";

function limits(over: Partial<ProcurementLimits> = {}): ProcurementLimits {
  return {
    endpointWhitelist: [ENDPOINT],
    maxSingleSpend: usdc6FromDecimal("1.00"),
    gatewayAvailable: usdc6FromDecimal("5.00"),
    ...over,
  };
}

describe("采购三约束", () => {
  it("三条都过才放行", () => {
    const verdict = checkProcurement(
      { endpoint: ENDPOINT, amount: usdc6FromDecimal("0.80") },
      limits(),
    );
    expect(verdict.allowed).toBe(true);
  });

  it("约束①白名单：未注册端点一律拒（逐字全等，不做通配）", () => {
    const verdict = checkProcurement(
      { endpoint: "https://evil.example/modules/us-msb/check", amount: usdc6FromDecimal("0.10") },
      limits(),
    );
    expect(verdict).toMatchObject({ allowed: false, denial: "not_whitelisted" });
  });

  it("约束①白名单：前缀相同但不全等也拒", () => {
    const verdict = checkProcurement(
      { endpoint: `${ENDPOINT}/../../drain`, amount: usdc6(1n) },
      limits(),
    );
    expect(verdict).toMatchObject({ allowed: false, denial: "not_whitelisted" });
  });

  it("约束②单笔上限", () => {
    const verdict = checkProcurement(
      { endpoint: ENDPOINT, amount: usdc6FromDecimal("1.01") },
      limits(),
    );
    expect(verdict).toMatchObject({ allowed: false, denial: "exceeds_single_cap" });
  });

  it("约束③Gateway 余额物理上限", () => {
    const verdict = checkProcurement(
      { endpoint: ENDPOINT, amount: usdc6FromDecimal("0.80") },
      limits({ gatewayAvailable: usdc6FromDecimal("0.50") }),
    );
    expect(verdict).toMatchObject({ allowed: false, denial: "insufficient_gateway_balance" });
  });

  it("案件级预算上限（可选第四条）", () => {
    const verdict = checkProcurement(
      { endpoint: ENDPOINT, amount: usdc6FromDecimal("0.80") },
      limits({ spentThisCase: usdc6FromDecimal("4.50"), maxPerCase: usdc6FromDecimal("5.00") }),
    );
    expect(verdict).toMatchObject({ allowed: false, denial: "exceeds_case_budget" });
  });

  it("恰好等于上限时放行（边界是闭区间）", () => {
    expect(
      checkProcurement({ endpoint: ENDPOINT, amount: usdc6FromDecimal("1.00") }, limits()).allowed,
    ).toBe(true);
  });

  it("拒绝信息不含任何密钥或材料，只有端点与金额", () => {
    const verdict = checkProcurement(
      { endpoint: "https://evil.example", amount: usdc6(1n) },
      limits(),
    );
    if (verdict.allowed) throw new Error("expected denial");
    expect(verdict.detail).not.toMatch(/sk-|0x[0-9a-f]{64}/);
  });
});

describe("付款失败 → 幂等重试 → 仍失败该腿转 HOLD", () => {
  it("空结算 ID 视为失败（合约 §9 实测坑）", () => {
    expect(isProcurementSuccessful({ ok: true, settlementId: "", attempts: 1 })).toBe(false);
    expect(isProcurementSuccessful({ ok: true, settlementId: "  ", attempts: 1 })).toBe(false);
    expect(isProcurementSuccessful({ ok: true, settlementId: "settle-1", attempts: 1 })).toBe(true);
  });

  it("重试到上限为止", () => {
    expect(shouldRetryProcurement({ ok: false, settlementId: "", attempts: 1 })).toBe(true);
    expect(
      shouldRetryProcurement({ ok: false, settlementId: "", attempts: PROCUREMENT_MAX_ATTEMPTS }),
    ).toBe(false);
    expect(shouldRetryProcurement({ ok: true, settlementId: "s", attempts: 1 })).toBe(false);
  });

  it("**该腿转 HOLD 不需要特殊代码路径**：采购失败即沿用采购前的 Module 结果，而它本来就算出 HOLD", () => {
    // 触发数据缺口的那份 Module 结果长这样：blocked_check_ids 非空。
    const preProcurement: PolicyModuleInput = {
      overall: "HOLD",
      settlement_constraints: {
        module: "us-msb",
        module_version: "2026.07.1",
        deal_id: "DEAL-1",
        valid_until: "2026-08-01T00:00:00Z",
        blocked_check_ids: ["MT-02"],
        escalated_check_ids: [],
        evidence_hash: "ab".repeat(32),
      },
    };
    // 采购失败 = 没有新的 Module 结果可合并 = 仍然只有上面这一份。
    expect(deriveCondition([preProcurement])).toBe("HOLD");
    // 所以不需要（也不允许）为"运营原因"开一条改判定的后门——不变量 2 不留缺口。
  });
});
