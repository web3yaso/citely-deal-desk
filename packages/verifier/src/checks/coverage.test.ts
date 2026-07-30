import { buildReviewJobTemplate } from "@citely/engine/escalation";
import { usdc6 } from "@citely/engine";
import { computeDeliverableHash } from "@citely/engine/sa";
import { parseRubric } from "@citely/engine/rubric";
import type { Rubric } from "@citely/engine/rubric";
import { describe, expect, it } from "vitest";

import { fixtureLeg, fixtureSaBody, FIXTURE_RUBRIC_ITEM_IDS } from "../testing/sa-fixture.js";
import type { SaBody, SettlementAuthorization } from "@citely/engine/sa";
import { checkRubricCoverage } from "./coverage.js";
import type { RubricRef } from "./coverage.js";

/** 检查③只看正文，attestation 用占位值填齐类型。 */
function withAttestation(body: SaBody): SettlementAuthorization {
  return {
    ...body,
    attestation: {
      sa_hash: `0x${"0".repeat(64)}`,
      signer: `0x${"1".repeat(40)}`,
      signed_at: "2026-07-28T00:00:00.000Z",
      signature: `0x${"2".repeat(130)}`,
    },
  };
}

/**
 * 出口 4 的升级材料 fixture。
 *
 * 用 engine 的 `buildReviewJobTemplate()` 构造而不是手写字面量：手写会漏字段，
 * 而且模板结构一变就要在每个 fixture 里改一遍。
 *
 * ⚠️ `expiresAt` 传的是**固定时刻**，不是 `new Date()`。模板要进 SA →
 * 进 `deliverableHash`，掺进"当前时刻"就会让同一份 SA 每次算出不同的哈希——
 * 这正是 `bound_to.expires_at` 刚修完的那个 bug 的第二个入口。
 */
const REVIEW_EXPIRES_AT = new Date("2026-08-15T00:00:00.000Z");

/** 委托人 = Marketplace（专家的钱来自委托人，不来自 Citely）。 */
const MARKETPLACE = `0x${"7".repeat(40)}` as const;
/** 受托方 = 专家，必须与委托人不同址。 */
const EXPERT = `0x${"8".repeat(40)}` as const;
const REVIEW_EVALUATOR = `0x${"9".repeat(40)}` as const;

function reviewTemplate(): ReturnType<typeof buildReviewJobTemplate> {
  return buildReviewJobTemplate({
    client: MARKETPLACE,
    provider: EXPERT,
    evaluator: REVIEW_EVALUATOR,
    expiresAt: REVIEW_EXPIRES_AT,
    // v2.3 §2.3 资金规划：Review 保证金 2.00 USDC。
    deposit: usdc6(2_000_000n),
    escalatedItemIds: FIXTURE_RUBRIC_ITEM_IDS,
  });
}

const rubricRef: RubricRef = {
  version: "2026.07.1",
  items: FIXTURE_RUBRIC_ITEM_IDS.map((id) => ({ id })),
};

/** 用 engine 的解析器造一份**真** rubric，验证两侧结构确实对得上。 */
function engineRubric(): Rubric {
  return parseRubric({
    scenario: "us-msb",
    version: "2026.07.1",
    last_verified_date: "2026-07-01",
    author: { name: "demo", license: "CC-BY-4.0", wallet: `0x${"5".repeat(40)}` },
    royalty_bps: 250,
    verdict_states: ["confirmed_in_scope", "confirmed_exempt", "gray_interpretive"],
    items: FIXTURE_RUBRIC_ITEM_IDS.map((id) => ({
      id,
      question: `question for ${id}`,
      signals: ["signal"],
      acceptance_criteria: ["criterion"],
      common_rejection_reasons: ["reason"],
      source: "31 CFR § 1010.100(ff)",
      confidence_rule: "high when registration is on file",
    })),
  });
}

describe("检查③：SA 覆盖 rubric 全部判定项", () => {
  it("全覆盖且每腿 condition 合法 → 通过", () => {
    const outcome = checkRubricCoverage({
      sa: withAttestation(fixtureSaBody()),
      rubric: rubricRef,
    });
    expect(outcome).toEqual({ check: "rubric_coverage", passed: true, failures: [] });
  });

  // T5：直接吃 engine 的 Rubric，不需要在两侧各维护一套 rubric 结构。
  it("engine 的 Rubric 可直接当 RubricRef 用（结构对齐，不是各写一套）", () => {
    const rubric = engineRubric();
    const outcome = checkRubricCoverage({ sa: withAttestation(fixtureSaBody()), rubric });
    expect(outcome.passed).toBe(true);
    expect(rubric.items.map((i) => i.id)).toEqual([...FIXTURE_RUBRIC_ITEM_IDS]);
  });

  it("漏了判定项 → 不通过，失败详情列出漏掉的 id", () => {
    const body = fixtureSaBody({
      legs: [fixtureLeg({ basis: [{ item_id: "msb-1", verdict: "x", source: "s" }] })],
    });
    const outcome = checkRubricCoverage({ sa: withAttestation(body), rubric: rubricRef });
    expect(outcome.passed).toBe(false);
    const failure = outcome.failures.find((f) => f.code === "rubric_items_uncovered");
    expect(failure?.detail).toBe("msb-2");
  });

  it("引用了 rubric 里不存在的判定项 → 不通过（依据不可复算）", () => {
    const body = fixtureSaBody({
      legs: [
        fixtureLeg({
          basis: [
            ...FIXTURE_RUBRIC_ITEM_IDS.map((id) => ({ item_id: id, verdict: "x", source: "s" })),
            { item_id: "made-up-item", verdict: "x", source: "s" },
          ],
        }),
      ],
    });
    const outcome = checkRubricCoverage({ sa: withAttestation(body), rubric: rubricRef });
    expect(outcome.failures.map((f) => f.code)).toContain("unknown_rubric_items");
  });

  it("condition 不在 PASS|HOLD|ESCALATE 内 → 不通过", () => {
    const body = fixtureSaBody({
      // 线格式来自外部 JSON，运行时可能出现类型系统挡不住的取值。
      legs: [{ ...fixtureLeg(), condition: "DEFINITELY_PAY" } as unknown as ReturnType<
        typeof fixtureLeg
      >],
    });
    const outcome = checkRubricCoverage({ sa: withAttestation(body), rubric: rubricRef });
    expect(outcome.failures.map((f) => f.code)).toContain("condition_invalid");
  });

  it("confidence 非法 → 不通过", () => {
    const body = fixtureSaBody({
      legs: [{ ...fixtureLeg(), confidence: "pretty sure" } as unknown as ReturnType<
        typeof fixtureLeg
      >],
    });
    const outcome = checkRubricCoverage({ sa: withAttestation(body), rubric: rubricRef });
    expect(outcome.failures.map((f) => f.code)).toContain("confidence_invalid");
  });

  it("一条腿都没有 → 不通过", () => {
    const outcome = checkRubricCoverage({
      sa: withAttestation(fixtureSaBody({ legs: [] })),
      rubric: rubricRef,
    });
    expect(outcome.failures.map((f) => f.code)).toContain("no_legs");
  });

  it("无依据的腿 → 不通过", () => {
    const outcome = checkRubricCoverage({
      sa: withAttestation(fixtureSaBody({ legs: [fixtureLeg({ basis: [] })] })),
      rubric: rubricRef,
    });
    expect(outcome.failures.map((f) => f.code)).toContain("leg_without_basis");
  });

  // 出口 4：ESCALATE 腿没有会谈卷宗就无从处置。
  it("ESCALATE 腿缺升级材料 → 不通过", () => {
    const outcome = checkRubricCoverage({
      sa: withAttestation(
        fixtureSaBody({
          legs: [fixtureLeg({ condition: "ESCALATE", confidence: "gray_interpretive" })],
        }),
      ),
      rubric: rubricRef,
    });
    expect(outcome.failures.map((f) => f.code)).toContain("escalation_material_missing");
  });

  it("ESCALATE 腿带上升级材料 → 通过", () => {
    const outcome = checkRubricCoverage({
      sa: withAttestation(
        fixtureSaBody({
          legs: [
            fixtureLeg({
              condition: "ESCALATE",
              confidence: "gray_interpretive",
              escalation: {
                review_job_template: reviewTemplate(),
                briefing_pack_hash: `0x${"4".repeat(64)}`,
              },
            }),
          ],
        }),
      ),
      rubric: rubricRef,
    });
    expect(outcome.passed).toBe(true);
  });

  it("preview.items_covered 与实际覆盖数对不上 → 不通过（摘要不许骗人）", () => {
    const body = { ...fixtureSaBody(), preview: { condition_summary: "x", items_covered: 99 } };
    const outcome = checkRubricCoverage({ sa: withAttestation(body), rubric: rubricRef });
    expect(outcome.failures.map((f) => f.code)).toContain("preview_items_covered_mismatch");
  });
});

describe("出口 4 升级材料的确定性（deliverableHash 的第二个入口）", () => {
  it("同样入参构造两次，模板逐字节相同", () => {
    expect(JSON.stringify(reviewTemplate())).toBe(JSON.stringify(reviewTemplate()));
  });

  it("模板不含任何随当前时刻变化的字段", () => {
    const first = reviewTemplate();
    const serialized = JSON.stringify(first);
    // 隔一会儿再构造一次：若实现里掺了 now()，两者就会分叉。
    const later = reviewTemplate();
    expect(JSON.stringify(later)).toBe(serialized);
    // 两个时间字段必须指向同一时刻，而不是各取一次 now。
    expect(first.expires_at).toBe(new Date(Number(first.expired_at_unix) * 1000).toISOString());
  });

  it("带该模板的 SA，deliverableHash 可复现", () => {
    const body = fixtureSaBody({
      legs: [
        fixtureLeg({
          condition: "ESCALATE",
          confidence: "gray_interpretive",
          escalation: {
            review_job_template: reviewTemplate(),
            briefing_pack_hash: `0x${"4".repeat(64)}`,
          },
        }),
      ],
    });
    expect(computeDeliverableHash(body)).toBe(computeDeliverableHash(body));
    // 换一份等价构造的模板，哈希仍应一致（模板本身确定性的直接后果）。
    const rebuilt = fixtureSaBody({
      legs: [
        fixtureLeg({
          condition: "ESCALATE",
          confidence: "gray_interpretive",
          escalation: {
            review_job_template: reviewTemplate(),
            briefing_pack_hash: `0x${"4".repeat(64)}`,
          },
        }),
      ],
    });
    expect(computeDeliverableHash(rebuilt)).toBe(computeDeliverableHash(body));
  });

  it("委托人恒为 Marketplace，且与专家不同址（专家的钱来自委托人）", () => {
    const t = reviewTemplate();
    expect(t.client).toBe(MARKETPLACE);
    expect(t.client).not.toBe(t.provider);
    expect(t.kind).toBe("erc8183_review_job");
    // 保证金由委托人出，金额是 v2.3 §2.3 的 2.00 USDC。
    expect(t.deposit_nominal).toBe("2000000");
  });
});
