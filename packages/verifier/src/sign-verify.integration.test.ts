/**
 * 集成点闭环实测：**engine 签、verifier 验**（主导交叉互审要求）。
 *
 * 这份测试刻意不读代码比对格式，而是走完整生产路径：
 * engine 的 `buildLegs`（Policy Engine）→ `buildSettlementAuthorization`
 * （组装 + 用运营账户 EIP-712 签名）→ verifier 的三检验签。
 * 两侧只要有一个字节对不上，这里就会红——这是我们唯一能证明两侧对齐的方式。
 *
 * 用的是**真 rubric**（`rubrics/us-msb.json`），不是 fixture。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseRubric } from "@citely/engine/rubric";
import type { Rubric } from "@citely/engine/rubric";
import { buildLegs } from "@citely/engine/policy";
import {
  ARC_TESTNET_CHAIN_ID,
  buildSaAttestationMessage,
  buildSettlementAuthorization,
  citelyDomain,
  computeDeliverableHash,
  saBody,
} from "@citely/engine/sa";
import type { SaLeg, SettlementAuthorization } from "@citely/engine/sa";
import { canonicalJson } from "@citely/engine/util/canonical";
import { usdc6 } from "@citely/engine";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import { signAttestationEntry } from "./attestation-source.js";
import type { AttestationManifest } from "./checks/attestation.js";
import { checkDeliverableSignature } from "./checks/signature.js";
import { PACKAGE_ROOT } from "./paths.js";
import type { TrustRegistry } from "./trust-registry.js";
import { verifySettlementAuthorization } from "./verify.js";

/** 合约 §2.1 的三把钥匙，物理分离。 */
const operator = privateKeyToAccount(generatePrivateKey()); // 8183 provider，SA 签名者
const verifierKey = privateKeyToAccount(generatePrivateKey()); // 8183 evaluator，验签方
const attester = privateKeyToAccount(generatePrivateKey()); // Module 认证方

const PAYEE = "0x000000000000000000000000000000000000bEEF" as Address;
const MODULE = { module_id: "us-msb", version: "2026.07.1" } as const;
const EVIDENCE_HASH = `0x${"ab".repeat(32)}` as Hex;

/** 真 rubric：`rubrics/us-msb.json`（engine 产出）。 */
function realRubric(): Rubric {
  const path = join(PACKAGE_ROOT, "..", "..", "rubrics", "us-msb.json");
  return parseRubric(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

const rubric = realRubric();

/** 走 engine 的 Policy Engine 组装腿：condition 只由 Module 结果推导（不变量 2）。 */
function productionLegs(): readonly SaLeg[] {
  return buildLegs([
    {
      party: "payee",
      payee: PAYEE,
      amount_nominal: usdc6(12_500_000n),
      modules: [
        {
          overall: "PASS",
          settlement_constraints: {
            module: "us-msb",
            module_version: MODULE.version,
            deal_id: "citely-demo-0001",
            valid_until: "2026-08-27T12:00:00Z",
            blocked_check_ids: [],
            escalated_check_ids: [],
            evidence_hash: "ab".repeat(32),
          },
        },
      ],
      basis: rubric.items.map((item) => ({
        item_id: item.id,
        verdict: "confirmed_exempt" as const,
        source: item.source,
      })),
    },
  ]);
}

/** 用 engine 的生产路径签一份 SA。 */
async function productionSa(signer = operator): Promise<SettlementAuthorization> {
  return await buildSettlementAuthorization({
    caseId: "citely-demo-0001",
    jobId: 12n,
    expiresAt: new Date("2026-08-04T00:00:00.000Z"),
    modulesUsed: [{ ...MODULE, evidence_hash: EVIDENCE_HASH }],
    legs: productionLegs(),
    itemsCovered: rubric.items.length,
    account: signer,
    chainId: ARC_TESTNET_CHAIN_ID,
  });
}

let sa: SettlementAuthorization;
let manifest: AttestationManifest;
let registry: TrustRegistry;

beforeAll(async () => {
  sa = await productionSa();
  manifest = {
    manifest_version: "1",
    entries: [
      await signAttestationEntry({
        moduleId: MODULE.module_id,
        version: MODULE.version,
        rulesHash: EVIDENCE_HASH,
        account: attester,
        chainId: ARC_TESTNET_CHAIN_ID,
      }),
    ],
  };
  // 合约 §5.1：citelySigners 填**运营**地址。
  registry = { citelySigners: [operator.address], moduleAttesters: [attester.address] };
});

describe("闭环：engine 签 → verifier 验", () => {
  it("engine 生产路径签出的 SA，三检全过", async () => {
    const report = await verifySettlementAuthorization({
      sa,
      rubric,
      manifest,
      registry,
      submittedDeliverableHash: sa.attestation.sa_hash,
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    expect(report.outcomes.filter((o) => !o.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("检查①单独跑也通过（共用同一个 message builder）", async () => {
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: [operator.address],
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    expect(outcome.passed).toBe(true);
  });

  it("SA 覆盖真 rubric 的全部 5 个判定项", async () => {
    const covered = new Set(sa.legs.flatMap((leg) => leg.basis.map((b) => b.item_id)));
    expect([...covered].sort()).toEqual(rubric.items.map((i) => i.id).sort());
    expect(sa.preview.items_covered).toBe(rubric.items.length);
  });
});

describe("集成点三项确认（主导复核项）", () => {
  it("domain = {CitelyDealDesk, 1, 5042002} 且**无 verifyingContract**", () => {
    const domain = citelyDomain();
    expect(domain).toEqual({ name: "CitelyDealDesk", version: "1", chainId: 5042002 });
    expect("verifyingContract" in domain).toBe(false);
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
  });

  it('deliverableHash = "0x" + sha256(canonicalJson(SA 去 attestation))', () => {
    // 独立复算一遍，不调 computeDeliverableHash，避免"自己证明自己"。
    const bytes = new TextEncoder().encode(canonicalJson(saBody(sa)));
    const expected = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    expect(computeDeliverableHash(sa)).toBe(expected);
    expect(sa.attestation.sa_hash).toBe(expected);
    // attestation 必须被剥掉，否则是循环定义。
    expect(Object.keys(saBody(sa))).not.toContain("attestation");
  });

  it("签名者是运营密钥，不是验证器密钥", () => {
    expect(sa.attestation.signer).toBe(operator.address);
    expect(sa.attestation.signer).not.toBe(verifierKey.address);
    expect(registry.citelySigners).toEqual([operator.address]);
    expect(registry.citelySigners).not.toContain(verifierKey.address);
  });

  // 检查①存在的意义：签名方与验签方必须是两把物理分离的钥匙。
  it("验证器自己签的 SA 被检查①拒绝（不是自己验自己）", async () => {
    const selfSigned = await productionSa(verifierKey);
    const outcome = await checkDeliverableSignature({
      sa: selfSigned,
      registeredSigners: [operator.address],
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.failures.map((f) => f.code)).toContain("signer_not_registered");
  });

  it("签名与验签共用同一个 message builder，产出逐字段一致", () => {
    const message = buildSaAttestationMessage(sa);
    expect(message.jobId).toBe(12n);
    expect(message.caseId).toBe(sa.case_id);
    expect(message.saVersion).toBe(sa.sa_version);
    expect(message.expiresAt).toBe(sa.bound_to.expires_at);
    expect(message.deliverableHash).toBe(sa.attestation.sa_hash);
  });
});

describe("篡改检测（闭环的负向面）", () => {
  it("改一条腿的金额 → 三检不通过", async () => {
    const first = sa.legs[0];
    if (first === undefined) throw new Error("fixture must have a leg");
    const tampered: SettlementAuthorization = {
      ...sa,
      legs: [{ ...first, amount_nominal: "99999999999" }],
    };
    const report = await verifySettlementAuthorization({
      sa: tampered,
      rubric,
      manifest,
      registry,
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    expect(report.passed).toBe(false);
  });

  it("改收款方地址 → 三检不通过（不变量 3 的完整性面）", async () => {
    const first = sa.legs[0];
    if (first === undefined) throw new Error("fixture must have a leg");
    const tampered: SettlementAuthorization = {
      ...sa,
      legs: [{ ...first, payee: operator.address }],
    };
    const report = await verifySettlementAuthorization({
      sa: tampered,
      rubric,
      manifest,
      registry,
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    expect(report.passed).toBe(false);
  });

  it("换 Module 版本 → 检查②找不到认证", async () => {
    const tampered: SettlementAuthorization = {
      ...sa,
      modules_used: [{ ...MODULE, version: "2025.01.1", evidence_hash: EVIDENCE_HASH }],
    };
    const report = await verifySettlementAuthorization({
      sa: tampered,
      rubric,
      manifest,
      registry,
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    expect(report.outcomes.find((o) => o.check === "module_attestation")?.passed).toBe(false);
  });
});
