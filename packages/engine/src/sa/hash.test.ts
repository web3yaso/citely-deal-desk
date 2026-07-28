import { describe, expect, it } from "vitest";

import { canonicalJson } from "../util/canonical.js";
import { sha256Hex } from "../util/hash.js";
import { computeDeliverableHash, saBody } from "./hash.js";
import type { SaBody, SettlementAuthorization } from "./types.js";

const BODY: SaBody = {
  case_id: "CASE-1",
  sa_version: "1",
  bound_to: { job_id: "42", expires_at: "2026-08-01T00:00:00.000Z" },
  modules_used: [{ module_id: "us-msb", version: "2026.07.1", evidence_hash: `0x${"ab".repeat(32)}` }],
  legs: [
    {
      party: "uk_service_agent",
      payee: "0x1111111111111111111111111111111111111111",
      amount_nominal: "1000000",
      condition: "PASS",
      basis: [{ item_id: "MT-01", verdict: "confirmed_exempt", source: "31 CFR § 1010.100(ff)" }],
      confidence: "high",
    },
  ],
  preview: { condition_summary: "1 PASS / 0 HOLD / 0 ESCALATE", items_covered: 1 },
};

const SA: SettlementAuthorization = {
  ...BODY,
  attestation: {
    sa_hash: `0x${"00".repeat(32)}`,
    signer: "0x2222222222222222222222222222222222222222",
    signed_at: "2026-07-28T00:00:00.000Z",
    signature: `0x${"11".repeat(65)}`,
  },
};

describe("saBody", () => {
  it("剥掉 attestation 后其余字段逐字保留", () => {
    expect(saBody(SA)).toEqual(BODY);
    expect("attestation" in saBody(SA)).toBe(false);
  });
});

describe("computeDeliverableHash", () => {
  it("等于 '0x' + sha256(canonicalJson(正文))", () => {
    const expected = `0x${sha256Hex(new TextEncoder().encode(canonicalJson(BODY)))}`;
    expect(computeDeliverableHash(BODY)).toBe(expected);
  });

  it("传完整 SA 与传正文得到同一个哈希（attestation 不参与哈希）", () => {
    expect(computeDeliverableHash(SA)).toBe(computeDeliverableHash(BODY));
  });

  it("改 attestation 不改变哈希，改正文一个字节即改变哈希", () => {
    const otherAttestation: SettlementAuthorization = {
      ...SA,
      attestation: { ...SA.attestation, signed_at: "2030-01-01T00:00:00.000Z" },
    };
    expect(computeDeliverableHash(otherAttestation)).toBe(computeDeliverableHash(SA));

    const mutated: SaBody = { ...BODY, case_id: "CASE-2" };
    expect(computeDeliverableHash(mutated)).not.toBe(computeDeliverableHash(BODY));
  });

  it("键序不影响哈希（规范化生效）", () => {
    const reordered = {
      preview: BODY.preview,
      legs: BODY.legs,
      modules_used: BODY.modules_used,
      bound_to: BODY.bound_to,
      sa_version: BODY.sa_version,
      case_id: BODY.case_id,
    } as SaBody;
    expect(computeDeliverableHash(reordered)).toBe(computeDeliverableHash(BODY));
  });

  it("形状是 0x + 64 位小写十六进制", () => {
    expect(computeDeliverableHash(BODY)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
