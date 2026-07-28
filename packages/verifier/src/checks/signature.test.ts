import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";

import { computeDeliverableHash } from "@citely/engine/sa";
import { fixtureSa } from "../testing/sa-fixture.js";
import type { SettlementAuthorization } from "@citely/engine/sa";
import { checkDeliverableSignature } from "./signature.js";

// 合约 §5.1：SA 由**运营密钥**签，由**验证器密钥**验——两把物理分离的钥匙。
const operator = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

let sa: SettlementAuthorization;

beforeAll(async () => {
  sa = await fixtureSa({ account: operator });
});

describe("检查①：deliverable 哈希的 EIP-712 验签", () => {
  it("由注册签名者签发、哈希自洽 → 通过", async () => {
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: [operator.address],
    });
    expect(outcome).toEqual({ check: "deliverable_signature", passed: true, failures: [] });
  });

  it("链上 submit 的哈希一致 → 通过（链上链下同一份交付物）", async () => {
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: [operator.address],
      submittedDeliverableHash: computeDeliverableHash(sa),
    });
    expect(outcome.passed).toBe(true);
  });

  it("链上 submit 的哈希对不上 → 不通过", async () => {
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: [operator.address],
      submittedDeliverableHash: `0x${"9".repeat(64)}`,
    });
    expect(outcome.failures.map((f) => f.code)).toContain("onchain_hash_mismatch");
  });

  it("SA 正文被改一个字 → 哈希对不上且验签失败", async () => {
    const original = sa.legs[0];
    if (original === undefined) throw new Error("fixture must have at least one leg");
    const tampered: SettlementAuthorization = {
      ...sa,
      legs: [{ ...original, amount_nominal: "999999999" }],
    };
    const outcome = await checkDeliverableSignature({
      sa: tampered,
      registeredSigners: [operator.address],
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.failures.map((f) => f.code)).toContain("sa_hash_mismatch");
  });

  it("签名者不在信任根里 → 不通过（不接受任意自签）", async () => {
    const selfSigned = await fixtureSa({ account: stranger });
    const outcome = await checkDeliverableSignature({
      sa: selfSigned,
      registeredSigners: [operator.address],
    });
    expect(outcome.failures.map((f) => f.code)).toContain("signer_not_registered");
  });

  it("信任根为空 → 不通过（空名单不等于全都信）", async () => {
    const outcome = await checkDeliverableSignature({ sa, registeredSigners: [] });
    expect(outcome.passed).toBe(false);
  });

  it("换个 chainId 验签失败（跨链重放挡住）", async () => {
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: [operator.address],
      chainId: 1,
    });
    expect(outcome.failures.map((f) => f.code)).toContain("signature_invalid");
  });

  it("换个 jobId 验签失败（跨案重放挡住）", async () => {
    const rebound: SettlementAuthorization = {
      ...sa,
      bound_to: { ...sa.bound_to, job_id: "13" },
    };
    const outcome = await checkDeliverableSignature({
      sa: rebound,
      registeredSigners: [operator.address],
    });
    expect(outcome.passed).toBe(false);
  });

  it("job_id 不是十进制整数 → 判不通过而不是让验证器崩溃", async () => {
    const broken: SettlementAuthorization = {
      ...sa,
      bound_to: { ...sa.bound_to, job_id: "twelve" },
    };
    const outcome = await checkDeliverableSignature({
      sa: broken,
      registeredSigners: [operator.address],
    });
    expect(outcome.failures.map((f) => f.code)).toContain("job_id_malformed");
  });

  it("签名字节畸形 → 判不通过而不是让验证器崩溃", async () => {
    const broken: SettlementAuthorization = {
      ...sa,
      attestation: { ...sa.attestation, signature: "0xdead" },
    };
    const outcome = await checkDeliverableSignature({
      sa: broken,
      registeredSigners: [operator.address],
    });
    expect(outcome.passed).toBe(false);
  });

  it("签名者地址大小写不影响信任根比对", async () => {
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: [operator.address.toLowerCase() as typeof operator.address],
    });
    expect(outcome.passed).toBe(true);
  });
});
