import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  ARC_TESTNET_CHAIN_ID,
  citelyDomain,
  SA_ATTESTATION_TYPES,
  SA_PRIMARY_TYPE,
} from "./eip712.js";
import { computeDeliverableHash } from "./hash.js";
import { buildSaAttestationMessage, InvalidJobIdError, parseJobId, signSaAttestation } from "./sign.js";
import type { SaBody } from "./types.js";

/** 测试专用私钥（viem 文档示例值，无资金、非任何真实密钥）。 */
const OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
/** 与运营密钥物理分离的另一把钥匙，用于断言"别的密钥签的验不过"。 */
const VERIFIER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

const BODY: SaBody = {
  case_id: "CASE-1",
  sa_version: "1",
  bound_to: { job_id: "42", expires_at: "2026-08-01T00:00:00.000Z" },
  modules_used: [],
  legs: [],
  preview: { condition_summary: "0 PASS / 0 HOLD / 0 ESCALATE", items_covered: 0 },
};

describe("parseJobId", () => {
  it("接受十进制整数字符串", () => {
    expect(parseJobId("0")).toBe(0n);
    expect(parseJobId("42")).toBe(42n);
  });

  it.each(["", "0x2a", "007", "-1", "1.5", "42 "])("拒绝非法形状 %o", (raw) => {
    expect(() => parseJobId(raw)).toThrow(InvalidJobIdError);
  });
});

describe("citelyDomain", () => {
  it("默认 Arc Testnet，且**没有** verifyingContract", () => {
    const domain = citelyDomain();
    expect(domain).toEqual({
      name: "CitelyDealDesk",
      version: "1",
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    expect(domain.verifyingContract).toBeUndefined();
  });
});

describe("buildSaAttestationMessage", () => {
  it("字段来自 bound_to 与正文哈希", () => {
    expect(buildSaAttestationMessage(BODY)).toEqual({
      caseId: "CASE-1",
      saVersion: "1",
      jobId: 42n,
      expiresAt: "2026-08-01T00:00:00.000Z",
      deliverableHash: computeDeliverableHash(BODY),
    });
  });
});

describe("signSaAttestation", () => {
  it("产出的签名可被同一 domain/types 验通过（签名侧与验签侧共用消息构造）", async () => {
    const account = privateKeyToAccount(OPERATOR_KEY);
    const attestation = await signSaAttestation({
      body: BODY,
      account,
      signedAt: new Date("2026-07-28T00:00:00.000Z"),
    });

    expect(attestation.signer).toBe(account.address);
    expect(attestation.sa_hash).toBe(computeDeliverableHash(BODY));
    expect(attestation.signed_at).toBe("2026-07-28T00:00:00.000Z");

    const ok = await verifyTypedData({
      address: account.address,
      domain: citelyDomain(),
      types: SA_ATTESTATION_TYPES,
      primaryType: SA_PRIMARY_TYPE,
      message: buildSaAttestationMessage(BODY),
      signature: attestation.signature,
    });
    expect(ok).toBe(true);
  });

  it("换一把密钥（验证器密钥）验签必须失败——检查①不许是自己验自己", async () => {
    const operator = privateKeyToAccount(OPERATOR_KEY);
    const verifier = privateKeyToAccount(VERIFIER_KEY);
    expect(verifier.address).not.toBe(operator.address);

    const attestation = await signSaAttestation({ body: BODY, account: operator });
    const ok = await verifyTypedData({
      address: verifier.address,
      domain: citelyDomain(),
      types: SA_ATTESTATION_TYPES,
      primaryType: SA_PRIMARY_TYPE,
      message: buildSaAttestationMessage(BODY),
      signature: attestation.signature,
    });
    expect(ok).toBe(false);
  });

  it("换 chainId 后旧签名验不过（跨链重放由 chainId 挡住）", async () => {
    const account = privateKeyToAccount(OPERATOR_KEY);
    const attestation = await signSaAttestation({ body: BODY, account });
    const ok = await verifyTypedData({
      address: account.address,
      domain: citelyDomain(1),
      types: SA_ATTESTATION_TYPES,
      primaryType: SA_PRIMARY_TYPE,
      message: buildSaAttestationMessage(BODY),
      signature: attestation.signature,
    });
    expect(ok).toBe(false);
  });

  it("正文改一个字节后旧签名验不过", async () => {
    const account = privateKeyToAccount(OPERATOR_KEY);
    const attestation = await signSaAttestation({ body: BODY, account });
    const mutated: SaBody = { ...BODY, case_id: "CASE-2" };
    const ok = await verifyTypedData({
      address: account.address,
      domain: citelyDomain(),
      types: SA_ATTESTATION_TYPES,
      primaryType: SA_PRIMARY_TYPE,
      message: buildSaAttestationMessage(mutated),
      signature: attestation.signature,
    });
    expect(ok).toBe(false);
  });
});
