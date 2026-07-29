import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { buildLegs } from "../policy/legs.js";
import {
  assertNoForbiddenWording,
  buildSaBody,
  buildSettlementAuthorization,
  FORBIDDEN_SA_PHRASES,
  SA_VERSION,
  SaWordingError,
} from "./build.js";
import { usdc6 } from "../util/usdc6.js";
import { computeDeliverableHash } from "./hash.js";
import { SA_DISCLAIMER } from "./types.js";
import type { SaLeg, SaModuleUsed } from "./types.js";

const OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const MODULES: readonly SaModuleUsed[] = [
  { module_id: "us-msb", version: "2026.07.1", evidence_hash: `0x${"ab".repeat(32)}` },
];

const LEGS: readonly SaLeg[] = buildLegs([
  {
    party: "uk_service_agent",
    payee: "0x1111111111111111111111111111111111111111",
    amount_nominal: usdc6(1000000n),
    modules: [
      {
        overall: "PASS",
        settlement_constraints: {
          module: "us-msb",
          module_version: "2026.07.1",
          deal_id: "DEAL-1",
          valid_until: "2026-08-01T00:00:00Z",
          blocked_check_ids: [],
          escalated_check_ids: [],
          evidence_hash: "ab".repeat(32),
        },
      },
    ],
    basis: [{ item_id: "MT-01", verdict: "confirmed_exempt", source: "31 CFR § 1010.100(ff)" }],
  },
]);

const PARAMS = {
  caseId: "CASE-1",
  jobId: 42n,
  expiresAt: new Date("2026-08-01T00:00:00.000Z"),
  modulesUsed: MODULES,
  legs: LEGS,
  itemsCovered: 1,
};

describe("buildSaBody", () => {
  it("字段集合逐字照录 v2.2 §4.2（正文六键，无 attestation）", () => {
    const body = buildSaBody(PARAMS);
    expect(Object.keys(body).sort()).toEqual([
      "bound_to",
      "case_id",
      "legs",
      "modules_used",
      "preview",
      "sa_version",
    ]);
    expect(body.sa_version).toBe(SA_VERSION);
  });

  it("jobId 与 expiresAt 归一为字符串/ISO8601", () => {
    const body = buildSaBody(PARAMS);
    expect(body.bound_to).toEqual({ job_id: "42", expires_at: "2026-08-01T00:00:00.000Z" });
    expect(buildSaBody({ ...PARAMS, jobId: "7", expiresAt: "2026-08-01T00:00:00Z" }).bound_to).toEqual(
      { job_id: "7", expires_at: "2026-08-01T00:00:00Z" },
    );
  });

  it("preview 由 legs 统计得出，也可显式覆盖", () => {
    expect(buildSaBody(PARAMS).preview).toEqual({
      condition_summary: "1 PASS / 0 HOLD / 0 ESCALATE",
      items_covered: 1,
    });
    const overridden = buildSaBody({
      ...PARAMS,
      preview: { condition_summary: "custom", items_covered: 9 },
    });
    expect(overridden.preview.items_covered).toBe(9);
  });
});

describe("措辞纪律（红线）", () => {
  it("正常 SA 不含任何禁用措辞", () => {
    const body = buildSaBody(PARAMS);
    const text = JSON.stringify(body).toLowerCase();
    for (const phrase of FORBIDDEN_SA_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  it("免责声明措辞是'条件证明，由钱包按自有预设策略核验执行'", () => {
    expect(SA_DISCLAIMER).toContain("条件证明");
    expect(SA_DISCLAIMER).toContain("由钱包按自有预设策略核验执行");
    expect(SA_DISCLAIMER).toContain("不构成法律意见");
    expect(SA_DISCLAIMER.toLowerCase()).not.toContain("authoriz");
  });

  it("任何字段里塞进 'Citely authorizes the payment' 都会被组装时挡下", () => {
    const poisoned = {
      ...PARAMS,
      legs: LEGS.map((leg) => ({ ...leg, party: "Citely authorizes the payment" })),
    };
    expect(() => buildSaBody(poisoned)).toThrow(SaWordingError);
  });

  it.each(FORBIDDEN_SA_PHRASES)("禁用措辞 %s 在任意大小写下都被检出", (phrase) => {
    expect(() => assertNoForbiddenWording({ note: phrase.toUpperCase() })).toThrow(SaWordingError);
  });

  it("干净对象通过检查", () => {
    expect(() => assertNoForbiddenWording({ note: "condition proof" })).not.toThrow();
  });
});

describe("buildSettlementAuthorization", () => {
  it("产出完整 SA，attestation.sa_hash 等于正文 deliverableHash", async () => {
    const account = privateKeyToAccount(OPERATOR_KEY);
    const sa = await buildSettlementAuthorization({
      ...PARAMS,
      account,
      signedAt: new Date("2026-07-28T00:00:00.000Z"),
    });

    expect(sa.attestation.signer).toBe(account.address);
    expect(sa.attestation.sa_hash).toBe(computeDeliverableHash(buildSaBody(PARAMS)));
    expect(sa.attestation.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(Object.keys(sa.attestation).sort()).toEqual([
      "sa_hash",
      "signature",
      "signed_at",
      "signer",
    ]);
  });

  it("两次组装同一输入得到逐字节相同的 SA（signedAt 固定时）", async () => {
    const account = privateKeyToAccount(OPERATOR_KEY);
    const signedAt = new Date("2026-07-28T00:00:00.000Z");
    const a = await buildSettlementAuthorization({ ...PARAMS, account, signedAt });
    const b = await buildSettlementAuthorization({ ...PARAMS, account, signedAt });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
