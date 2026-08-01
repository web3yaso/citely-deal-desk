/**
 * 编排各阶段的单测。重点在三条不可回退的性质：
 * 1. `condition` 只由 Module 结果推导（不变量 2）；
 * 2. 同样输入两次组装得到**逐字节相同**的 `sa_hash`；
 * 3. 重跑时状态机单调推进、账本被幂等挡下。
 */

import type { ModuleResponse } from "@citely/chain/types";
import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { openDatabase, type EngineDatabase } from "../db/schema.js";
import { CaseStore } from "../db/store.js";
import { entryForModuleFee } from "../ledger/entries.js";
import { LedgerStore } from "../ledger/store.js";
import type { LoadedRubric } from "../rubric/types.js";
import { sanitizeMaterial } from "../sandbox/index.js";
import { usdc6FromDecimal } from "../util/usdc6.js";
import {
  advanceCaseState,
  assembleSa,
  buildSettlementLegs,
  completeLedger,
  deriveIntakeStatus,
  intake,
  procurementLedger,
  recordLedgerIdempotent,
  toRoutingSummaries,
} from "./stages.js";

/** viem 文档示例密钥，无资金，仅本地签名。 */
const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const CASE_ID = "citely-demo-0001";
const PAYEE = "0x000000000000000000000000000000000000bEEF" as const;
const JOB_EXPIRED_AT = BigInt(Math.floor(Date.parse("2026-12-31T00:00:00.000Z") / 1000));

const RUBRIC: LoadedRubric = {
  id: "us-msb",
  rubric: {
    scenario: "us-msb",
    version: "2026.07",
    last_verified_date: "2026-07-12",
    author: { name: "citely", license: "CC-BY-4.0", wallet: PAYEE },
    royalty_bps: 500,
    items: [
      {
        id: "MT-01",
        question: "是否构成 money transmitter？",
        signals: ["接收资金"],
        acceptance_criteria: ["有证据"],
        common_rejection_reasons: ["只描述了收款"],
        source: "31 CFR § 1010.100(ff)",
        confidence_rule: "任一 signal 缺失 → gray_data",
      },
    ],
    verdict_states: ["confirmed_in_scope", "confirmed_exempt", "gray_interpretive"],
  },
};

function moduleResponse(over: Partial<ModuleResponse> = {}): ModuleResponse {
  return {
    module: "us-msb",
    version: "2026.07.1",
    updated_at: "2026-07-12T00:00:00Z",
    maintainer_wallet: "0x76B05e56872E097dB94Ee8cD55de7882603047B9",
    royalty_bps: 500,
    checks: [
      { id: "MT-02", result: "HOLD", basis: "missing_evidence", reason: "no registration", source: "31 CFR" },
    ],
    overall: "HOLD",
    settlement_constraints: {
      module: "us-msb",
      module_version: "2026.07.1",
      deal_id: CASE_ID,
      valid_until: "2026-08-01T00:00:00Z",
      blocked_check_ids: ["MT-02"],
      escalated_check_ids: [],
      evaluated_check_count: 1,
      evidence_hash: "ab".repeat(32),
    },
    evidence_hash: "ab".repeat(32),
    engine_version: "1.0.0",
    hash_scheme_version: "2",
    disclaimer: "输出为基于公开法源整理的检查项状态，不构成法律意见。",
    ...over,
  };
}

const FACTS = intake({ evidence: { note: "counterparty is licensed" }, activity: "payments" });

describe("intake / deriveIntakeStatus", () => {
  it("材料过沙箱后才进判定器（不变量 5）", () => {
    expect(FACTS.material_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(FACTS.fields)).toContain("activity");
  });

  it("解析不出任何字段 → unparsable（出口 1）", () => {
    const empty = sanitizeMaterial({ fields: {} });
    expect(deriveIntakeStatus(empty, RUBRIC)).toBe("unparsable");
  });

  it("rubric 没有判定项 → out_of_rubric_scope（出口 1）", () => {
    const emptyRubric: LoadedRubric = { ...RUBRIC, rubric: { ...RUBRIC.rubric, items: [] } };
    expect(deriveIntakeStatus(FACTS, emptyRubric)).toBe("out_of_rubric_scope");
  });

  it("正常材料 → ok", () => {
    expect(deriveIntakeStatus(FACTS, RUBRIC)).toBe("ok");
  });
});

describe("toRoutingSummaries", () => {
  it("采购已完成的案件，剩下的数据缺口标为已耗尽（该走出口 4 而不是再买一轮）", () => {
    const summaries = toRoutingSummaries(
      [
        {
          item_id: "MT-01",
          verdict: "gray_data",
          gray_type: "data",
          confidence: "low",
          risk_flags: [],
          source: "31 CFR",
          cacheHit: false,
          repairs: [],
        },
      ],
      true,
    );
    expect(summaries[0]?.procurementExhausted).toBe(true);
    expect(summaries[0]?.gray_type).toBe("data");
  });

  it("gray_type 缺省时不写这个键（exactOptionalPropertyTypes 下不许塞 undefined）", () => {
    const summaries = toRoutingSummaries(
      [
        {
          item_id: "MT-01",
          verdict: "confirmed_exempt",
          gray_type: undefined,
          confidence: "high",
          risk_flags: [],
          source: "31 CFR",
          cacheHit: true,
          repairs: [],
        },
      ],
      false,
    );
    expect("gray_type" in (summaries[0] ?? {})).toBe(false);
  });
});

describe("buildSettlementLegs", () => {
  it("condition 只由 Module 结果推导：verdict 换成最宽松的也不改 condition（不变量 2）", () => {
    const strict = buildSettlementLegs({
      party: "payee",
      payee: PAYEE,
      amountAtomic: usdc6FromDecimal("12.50"),
      moduleResponse: moduleResponse(),
      rubric: RUBRIC,
      verdicts: { "MT-01": "confirmed_in_scope" },
    });
    const lenient = buildSettlementLegs({
      party: "payee",
      payee: PAYEE,
      amountAtomic: usdc6FromDecimal("12.50"),
      moduleResponse: moduleResponse(),
      rubric: RUBRIC,
      verdicts: { "MT-01": "confirmed_exempt" },
    });

    expect(strict[0]?.condition).toBe("HOLD");
    expect(lenient[0]?.condition).toBe(strict[0]?.condition);
  });

  it("漏判定项立刻响亮失败", () => {
    expect(() =>
      buildSettlementLegs({
        party: "payee",
        payee: PAYEE,
        amountAtomic: usdc6FromDecimal("12.50"),
        moduleResponse: moduleResponse(),
        rubric: RUBRIC,
        verdicts: {},
      }),
    ).toThrow(/missing adjudication verdict/);
  });
});

describe("assembleSa", () => {
  it("同样输入两次组装得到同一个 sa_hash（signed_at 不进哈希）", async () => {
    const legs = buildSettlementLegs({
      party: "payee",
      payee: PAYEE,
      amountAtomic: usdc6FromDecimal("12.50"),
      moduleResponse: moduleResponse(),
      rubric: RUBRIC,
      verdicts: { "MT-01": "confirmed_exempt" },
    });
    const params = {
      caseId: CASE_ID,
      jobId: 7n,
      expiresAt: JOB_EXPIRED_AT,
      moduleResponse: moduleResponse(),
      legs,
      itemsCovered: 1,
      operatorAccount: privateKeyToAccount(DEMO_KEY),
      chainId: 10143,
    } as const;

    const first = await assembleSa({ ...params, signedAt: new Date("2026-07-30T01:00:00Z") });
    const second = await assembleSa({ ...params, signedAt: new Date("2026-07-30T09:00:00Z") });

    expect(second.attestation.sa_hash).toBe(first.attestation.sa_hash);
  });
});

describe("procurementLedger", () => {
  it("有版税配置 → module_fee + royalty 两行，ref 都是 Gateway 回执", () => {
    const rows = procurementLedger({
      caseId: CASE_ID,
      quoted: usdc6FromDecimal("0.80"),
      paid: usdc6FromDecimal("0.80"),
      gatewayReceipt: "gw-1",
      maintainerWallet: "0x76B05e56872E097dB94Ee8cD55de7882603047B9",
      royaltyBps: 500,
    });

    expect(rows.map((r) => r.category)).toEqual(["module_fee", "royalty"]);
    expect(rows.every((r) => r.ref === "gw-1" && r.ref_type === "gateway_receipt")).toBe(true);
    expect(rows[1]?.amount_actual).toBe(usdc6FromDecimal("0.04"));
  });

  it("零地址 maintainer → 不产生 royalty 行（不得向零地址转账）", () => {
    const rows = procurementLedger({
      caseId: CASE_ID,
      quoted: usdc6FromDecimal("0.80"),
      paid: usdc6FromDecimal("0.80"),
      gatewayReceipt: "gw-1",
      maintainerWallet: "0x0000000000000000000000000000000000000000",
      royaltyBps: 500,
    });
    expect(rows).toHaveLength(1);
  });
});

describe("completeLedger", () => {
  it("净额来自链上费率，不硬编码", () => {
    const entries = completeLedger({
      caseId: CASE_ID,
      jobId: 7n,
      budget: usdc6FromDecimal("3.00"),
      fees: { platformFeeBP: 250n, evaluatorFeeBP: 100n },
    });
    const operator = entries.find((e) => e.account === "operator");
    expect(operator?.amount_nominal).toBe(usdc6FromDecimal("3.00"));
    expect(operator?.amount_actual).toBeLessThan(usdc6FromDecimal("3.00"));
  });
});

describe("recordLedgerIdempotent / advanceCaseState", () => {
  let db: EngineDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("重跑同一批条目：全部被幂等挡下，库里行数不变", () => {
    const ledger = new LedgerStore(db);
    const entries = [
      entryForModuleFee({
        caseId: CASE_ID,
        quoted: usdc6FromDecimal("0.80"),
        paid: usdc6FromDecimal("0.80"),
        gatewayReceipt: "gw-1",
      }),
    ];

    expect(recordLedgerIdempotent(ledger, entries)).toEqual({ inserted: 1, skipped: 0 });
    expect(recordLedgerIdempotent(ledger, entries)).toEqual({ inserted: 0, skipped: 1 });
    expect(ledger.list(CASE_ID)).toHaveLength(1);
  });

  it("状态单调推进：重跑时已到达的阶段被跳过而不是抛非法跃迁", () => {
    const cases = new CaseStore(db);
    cases.ensureCase(CASE_ID);

    expect(advanceCaseState(cases, CASE_ID, "assessing")).toBe(true);
    expect(cases.getCase(CASE_ID).state).toBe("assessing");
    // 重跑：目标态在当前之前 → 什么都不做
    expect(advanceCaseState(cases, CASE_ID, "decomposed")).toBe(false);
    expect(cases.getCase(CASE_ID).state).toBe("assessing");
  });

  it("终局态之后不再被推回中间态", () => {
    const cases = new CaseStore(db);
    cases.ensureCase(CASE_ID);
    advanceCaseState(cases, CASE_ID, "submitted");
    cases.transitionCase(CASE_ID, "settled", "completed");

    expect(advanceCaseState(cases, CASE_ID, "conditions_ready")).toBe(false);
    expect(cases.getCase(CASE_ID).state).toBe("settled");
  });

  it("终局态不走 advanceCaseState（必须带出口原因显式跃迁）", () => {
    const cases = new CaseStore(db);
    cases.ensureCase(CASE_ID);
    expect(() => advanceCaseState(cases, CASE_ID, "settled")).toThrow(/terminal state/);
  });
});
