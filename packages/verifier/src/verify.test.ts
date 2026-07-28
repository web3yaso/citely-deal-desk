import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";

import { signAttestationEntry } from "./attestation-source.js";
import type { AttestationManifest } from "./checks/attestation.js";
import type { RubricRef } from "./checks/coverage.js";
import { reasonHash } from "./reason.js";
import { computeDeliverableHash } from "@citely/engine/sa";
import type { SettlementAuthorization } from "@citely/engine/sa";
import { fixtureLeg, fixtureSa, fixtureSaBody, FIXTURE_MODULE, FIXTURE_RUBRIC_ITEM_IDS } from "./testing/sa-fixture.js";
import type { TrustRegistry } from "./trust-registry.js";
import { verifySettlementAuthorization } from "./verify.js";

const operator = privateKeyToAccount(generatePrivateKey());
const attester = privateKeyToAccount(generatePrivateKey());

const rubric: RubricRef = {
  version: "2026.07.1",
  items: FIXTURE_RUBRIC_ITEM_IDS.map((id) => ({ id })),
};

let sa: SettlementAuthorization;
let manifest: AttestationManifest;
let registry: TrustRegistry;

beforeAll(async () => {
  sa = await fixtureSa({ account: operator });
  manifest = {
    manifest_version: "1",
    entries: [
      await signAttestationEntry({
        moduleId: FIXTURE_MODULE.module_id,
        version: FIXTURE_MODULE.version,
        rulesHash: `0x${"1".repeat(64)}`,
        account: attester,
      }),
    ],
  };
  registry = { citelySigners: [operator.address], moduleAttesters: [attester.address] };
});

describe("三检编排", () => {
  it("三检全过 → passed，reasonHash 是 32 字节哈希", async () => {
    const report = await verifySettlementAuthorization({ sa, rubric, manifest, registry });

    expect(report.passed).toBe(true);
    expect(report.outcomes.map((o) => o.check)).toEqual([
      "deliverable_signature",
      "module_attestation",
      "rubric_coverage",
    ]);
    expect(report.saHash).toBe(computeDeliverableHash(sa));
    expect(report.reason.outcome).toBe("accepted");
    // 不变量 4：上链的是哈希不是明文。
    expect(report.reasonHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.reasonHash).toBe(reasonHash(report.reason));
  });

  // 出口 1 需要完整失败画像，只报第一条会让运营反复试错。
  it("三检不短路：一检失败时其余两检仍然执行并汇总", async () => {
    const report = await verifySettlementAuthorization({
      sa,
      rubric,
      manifest: { manifest_version: "1", entries: [] },
      registry,
    });

    expect(report.passed).toBe(false);
    expect(report.outcomes).toHaveLength(3);
    expect(report.outcomes.find((o) => o.check === "deliverable_signature")?.passed).toBe(true);
    expect(report.outcomes.find((o) => o.check === "module_attestation")?.passed).toBe(false);
    expect(report.outcomes.find((o) => o.check === "rubric_coverage")?.passed).toBe(true);
    expect(report.reason.outcome).toBe("rejected");
  });

  it("三检同时失败时三条都出现在理由里", async () => {
    const rogue = await fixtureSa({
      account: privateKeyToAccount(generatePrivateKey()),
      body: { legs: [fixtureLeg({ basis: [] })] },
    });
    const report = await verifySettlementAuthorization({
      sa: rogue,
      rubric,
      manifest: { manifest_version: "1", entries: [] },
      registry,
    });
    expect(report.outcomes.every((o) => !o.passed)).toBe(true);
  });

  it("理由只收稳定失败码，不收 detail 自由文本（哈希稳定 + 不夹带材料）", async () => {
    const report = await verifySettlementAuthorization({
      sa,
      rubric,
      manifest: { manifest_version: "1", entries: [] },
      registry,
    });
    const serialized = JSON.stringify(report.reason);
    expect(serialized).toContain("attestation_missing");
    expect(serialized).not.toContain(FIXTURE_MODULE.module_id);
  });

  it("同一份 SA 与同一组结论算出同一个 reasonHash（可复算）", async () => {
    const a = await verifySettlementAuthorization({ sa, rubric, manifest, registry });
    const b = await verifySettlementAuthorization({ sa, rubric, manifest, registry });
    expect(a.reasonHash).toBe(b.reasonHash);
  });

  it("失败码的先后顺序不影响 reasonHash（进哈希前已排序去重）", async () => {
    const report = await verifySettlementAuthorization({ sa, rubric, manifest, registry });
    for (const check of report.reason.checks) {
      expect([...check.codes]).toEqual([...check.codes].sort());
    }
  });

  it("链上 submit 的哈希对不上 → 不通过", async () => {
    const report = await verifySettlementAuthorization({
      sa,
      rubric,
      manifest,
      registry,
      submittedDeliverableHash: `0x${"7".repeat(64)}`,
    });
    expect(report.passed).toBe(false);
  });

  it("SA 覆盖不全 → 不通过", async () => {
    const partial = await fixtureSa({
      account: operator,
      body: {
        legs: [fixtureLeg({ basis: [{ item_id: "msb-1", verdict: "x", source: "s" }] })],
      },
    });
    const report = await verifySettlementAuthorization({ sa: partial, rubric, manifest, registry });
    expect(report.passed).toBe(false);
    expect(report.outcomes.find((o) => o.check === "rubric_coverage")?.passed).toBe(false);
  });

  it("理由绑定到 SA 哈希与 jobId（不会张冠李戴）", async () => {
    const report = await verifySettlementAuthorization({ sa, rubric, manifest, registry });
    expect(report.reason.sa_hash).toBe(computeDeliverableHash(fixtureSaBody()));
    expect(report.reason.job_id).toBe(sa.bound_to.job_id);
  });
});
