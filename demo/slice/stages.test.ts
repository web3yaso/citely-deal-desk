import type { ModuleResponse } from "@citely/chain";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { CLEAN_DEAL_INPUT, INJECTED_DEAL_INPUT } from "../fixtures/deal-input.js";
import { RECORDED_MODULE_RESPONSE } from "../fixtures/module-response.js";
import { loadDemoRubric } from "../fixtures/rubric.js";
import { assembleSa, buildSettlementLegs, completeLedger, intake } from "./stages.js";
import type { ItemVerdicts } from "./stages.js";

const PAYEE = `0x${"1".repeat(40)}` as Address;
const rubric = loadDemoRubric().loaded;
const verdicts: ItemVerdicts = Object.fromEntries(
  rubric.rubric.items.map((item) => [item.id, "confirmed_exempt" as const]),
);

function moduleWith(over: Partial<ModuleResponse["settlement_constraints"]>): ModuleResponse {
  return {
    ...RECORDED_MODULE_RESPONSE,
    settlement_constraints: { ...RECORDED_MODULE_RESPONSE.settlement_constraints, ...over },
  };
}

describe("intake", () => {
  it("干净版材料无注入标记", () => {
    expect(intake(CLEAN_DEAL_INPUT).detected_flags).toEqual([]);
  });

  it("注入版材料被沙箱标记", () => {
    expect(intake(INJECTED_DEAL_INPUT).detected_flags).toContain("injection_attempt");
  });
});

describe("buildSettlementLegs（不变量 2：condition 只由 Module 结果推导）", () => {
  it("Module 全 PASS → condition=PASS", () => {
    const legs = buildSettlementLegs({
      payee: PAYEE,
      amountAtomic: 12_500_000n,
      moduleResponse: RECORDED_MODULE_RESPONSE,
      rubric,
      verdicts,
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]?.condition).toBe("PASS");
    expect(legs[0]?.payee).toBe(PAYEE);
  });

  it("Module 报 blocked → condition 收紧为 HOLD", () => {
    const legs = buildSettlementLegs({
      payee: PAYEE,
      amountAtomic: 1n,
      moduleResponse: moduleWith({ blocked_check_ids: ["msb-registration"] }),
      rubric,
      verdicts,
    });
    expect(legs[0]?.condition).toBe("HOLD");
  });

  it("Module 报 escalated → condition 收紧为 ESCALATE", () => {
    const legs = buildSettlementLegs({
      payee: PAYEE,
      amountAtomic: 1n,
      moduleResponse: moduleWith({ escalated_check_ids: ["msb-state-licensing"] }),
      rubric,
      verdicts,
    });
    expect(legs[0]?.condition).toBe("ESCALATE");
  });

  // A7 的精神：判定器被完全策反也改不了 condition。
  it("把全部 verdict 换掉，condition 一个字节不变", () => {
    const base = buildSettlementLegs({
      payee: PAYEE,
      amountAtomic: 1n,
      moduleResponse: moduleWith({ blocked_check_ids: ["msb-registration"] }),
      rubric,
      verdicts,
    });
    const flipped: ItemVerdicts = Object.fromEntries(
      rubric.rubric.items.map((item) => [item.id, "confirmed_in_scope" as const]),
    );
    const after = buildSettlementLegs({
      payee: PAYEE,
      amountAtomic: 1n,
      moduleResponse: moduleWith({ blocked_check_ids: ["msb-registration"] }),
      rubric,
      verdicts: flipped,
    });
    expect(after.map((l) => l.condition)).toEqual(base.map((l) => l.condition));
  });

  it("漏了某个 rubric 判定项的 verdict → 响亮抛错", () => {
    expect(() =>
      buildSettlementLegs({
        payee: PAYEE,
        amountAtomic: 1n,
        moduleResponse: RECORDED_MODULE_RESPONSE,
        rubric,
        verdicts: {},
      }),
    ).toThrow(/missing adjudication verdict/);
  });

  it("金额落进 SA 是十进制字符串，不是浮点", () => {
    const legs = buildSettlementLegs({
      payee: PAYEE,
      amountAtomic: 12_500_000n,
      moduleResponse: RECORDED_MODULE_RESPONSE,
      rubric,
      verdicts,
    });
    expect(legs[0]?.amount_nominal).toBe("12500000");
  });
});

describe("assembleSa", () => {
  it("由运营账户签名，绑定 jobId 与 Module 版本", async () => {
    const operator = privateKeyToAccount(generatePrivateKey());
    const legs = buildSettlementLegs({
      payee: PAYEE,
      amountAtomic: 12_500_000n,
      moduleResponse: RECORDED_MODULE_RESPONSE,
      rubric,
      verdicts,
    });
    const sa = await assembleSa({
      caseId: "citely-demo-0001",
      jobId: 7n,
      expiresAt: new Date("2026-08-04T00:00:00.000Z"),
      moduleResponse: RECORDED_MODULE_RESPONSE,
      legs,
      itemsCovered: rubric.rubric.items.length,
      operatorAccount: operator,
      chainId: 5042002,
    });

    expect(sa.bound_to.job_id).toBe("7");
    expect(sa.attestation.signer).toBe(operator.address);
    expect(sa.modules_used[0]?.module_id).toBe("us-msb");
    expect(sa.attestation.sa_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("SA 文案不含「Citely 授权付款」这类措辞（红线，由 engine 的措辞扫描保证）", async () => {
    const operator = privateKeyToAccount(generatePrivateKey());
    const sa = await assembleSa({
      caseId: "citely-demo-0001",
      jobId: 7n,
      expiresAt: new Date("2026-08-04T00:00:00.000Z"),
      moduleResponse: RECORDED_MODULE_RESPONSE,
      legs: buildSettlementLegs({
        payee: PAYEE,
        amountAtomic: 1n,
        moduleResponse: RECORDED_MODULE_RESPONSE,
        rubric,
        verdicts,
      }),
      itemsCovered: rubric.rubric.items.length,
      operatorAccount: operator,
      chainId: 5042002,
    });
    expect(JSON.stringify(sa).toLowerCase()).not.toContain("citely authorizes");
  });
});

describe("completeLedger（合约 §2.4，数字全部来自 engine 的账本条目）", () => {
  const base = {
    caseId: "citely-demo-0001",
    jobId: 7n,
    txHash: `0x${"ab".repeat(32)}`,
    budget: 3_000_000n,
  };

  it("非零费率：provider 实收 net < budget", () => {
    const split = completeLedger({ ...base, fees: { platformFeeBP: 200n, evaluatorFeeBP: 100n } });
    expect(split.platformFee).toBe(60_000n);
    expect(split.evaluatorFee).toBe(30_000n);
    expect(split.net).toBe(2_910_000n);
    expect(split.net).toBeLessThan(split.budget);
  });

  // 真链当前部署实测 platformFeeBP=0 / evaluatorFeeBP=0，这不是边界而是现状。
  it("零费率（当前 Arc Testnet 部署的实际值）：net 等于 budget", () => {
    const split = completeLedger({ ...base, fees: { platformFeeBP: 0n, evaluatorFeeBP: 0n } });
    expect(split.net).toBe(3_000_000n);
    expect(split.net).toBe(split.budget);
    expect(split.platformFee).toBe(0n);
  });

  it("三份金额加起来等于 budget（对账闭合）", () => {
    const split = completeLedger({ ...base, fees: { platformFeeBP: 250n, evaluatorFeeBP: 75n } });
    expect(split.platformFee + split.evaluatorFee + split.net).toBe(split.budget);
  });

  // 终验要对"链上事件金额 ↔ 账本 amount_actual"，所以打印的数必须就是账本里的数。
  it("打印用的 net/evalFee 就是账本条目的 amount_actual（不是另算一遍）", () => {
    const split = completeLedger({ ...base, fees: { platformFeeBP: 200n, evaluatorFeeBP: 100n } });
    const operator = split.entries.find((e) => e.account === "operator");
    const verifier = split.entries.find((e) => e.account === "verifier");
    expect(operator?.amount_actual).toBe(split.net);
    expect(operator?.amount_nominal).toBe(split.budget);
    expect(verifier?.amount_actual).toBe(split.evaluatorFee);
  });

  it("账本条目带上 jobId/txHash/caseId，能与链上事件对上号", () => {
    const split = completeLedger({ ...base, fees: { platformFeeBP: 0n, evaluatorFeeBP: 0n } });
    expect(split.entries).toHaveLength(2);
    for (const entry of split.entries) {
      expect(entry.jobId).toBe(7n);
      expect(entry.txHash).toBe(base.txHash);
      expect(entry.caseId).toBe("citely-demo-0001");
      expect(entry.category).toBe("case_fee");
      expect(entry.direction).toBe("in");
    }
  });

  it("金额一律 bigint，不出现浮点", () => {
    const split = completeLedger({ ...base, fees: { platformFeeBP: 333n, evaluatorFeeBP: 111n } });
    for (const entry of split.entries) {
      expect(typeof entry.amount_nominal).toBe("bigint");
      expect(typeof entry.amount_actual).toBe("bigint");
    }
  });
});
