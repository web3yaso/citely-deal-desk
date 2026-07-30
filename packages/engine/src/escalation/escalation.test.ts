/**
 * 出口 4 产出物的测试：会谈卷宗 + Review Job 模板（v2.3 §2.2）。
 */

import { describe, expect, it } from "vitest";

import { assertNoForbiddenWording } from "../sa/build.js";
import { usdc6FromDecimal } from "../util/usdc6.js";
import {
  assertNarrativeIsNotDecisional,
  BRIEFING_DISCLAIMER,
  briefingPackHash,
  buildBriefingPack,
  DecisionalNarrativeError,
  EmptyBriefingPackError,
} from "./briefing.js";
import type { BriefingItem, BriefingNarrative, BuildBriefingPackParams } from "./briefing.js";
import { buildEscalation } from "./index.js";
import {
  buildReviewJobTemplate,
  InvalidReviewJobRolesError,
  isReviewJobTemplate,
  REVIEW_JOB_TEMPLATE_KIND,
  ZERO_ADDRESS,
} from "./review-job.js";

const MARKETPLACE = "0x2222222222222222222222222222222222222222";
const EXPERT = "0x3333333333333333333333333333333333333333";
const VERIFIER = "0x4444444444444444444444444444444444444444";

const ITEM: BriefingItem = {
  item_id: "MT-03",
  question: "该主体是否落入'资金传输仅为另一项非货币传输服务之组成部分'的除外情形？",
  source: "31 CFR § 1010.100(ff)(5)(ii)(F) / FinCEN Ruling FIN-2008-R003",
  verdict: "gray_interpretive",
  gray_type: "interpretive",
  confidence_rule: "'必需性'的判断依赖法律解释 → gray_interpretive",
};

function briefingParams(over: Partial<BuildBriefingPackParams> = {}): BuildBriefingPackParams {
  return {
    caseId: "CASE-1",
    rubricId: "us-msb",
    rubricVersion: "2026.07",
    modulesUsed: [
      { module_id: "us-msb", version: "2026.07.1", evidence_hash: "ab".repeat(32) },
    ],
    items: [ITEM],
    materialSha256: "cd".repeat(32),
    ...over,
  };
}

function reviewJobParams() {
  return {
    client: MARKETPLACE,
    provider: EXPERT,
    evaluator: VERIFIER,
    expiresAt: new Date("2026-08-05T00:00:00.000Z"),
    deposit: usdc6FromDecimal("2.00"),
    escalatedItemIds: ["MT-03"],
  } as const;
}

// ───────────────────────── Review Job 模板 ─────────────────────────

describe("Review Job 模板：client 必须是 Marketplace", () => {
  it("client 填 Marketplace，保证金由它注资（专家的钱永远来自委托人）", () => {
    const template = buildReviewJobTemplate(reviewJobParams());
    expect(template.client).toBe(MARKETPLACE);
    expect(template.deposit_nominal).toBe("2000000");
    expect(template.kind).toBe(REVIEW_JOB_TEMPLATE_KIND);
  });

  it("含 8183 createJob 所需的全部字段", () => {
    const template = buildReviewJobTemplate(reviewJobParams());
    expect(template.provider).toBe(EXPERT);
    expect(template.evaluator).toBe(VERIFIER);
    expect(template.hook).toBe(ZERO_ADDRESS);
    expect(template.description).toContain("MT-03");
    expect(template.expired_at_unix).toBe(
      String(Math.floor(new Date("2026-08-05T00:00:00.000Z").getTime() / 1000)),
    );
  });

  it("expired_at_unix 与 expires_at 指向同一时刻（不是各自取一次 now）", () => {
    const template = buildReviewJobTemplate(reviewJobParams());
    expect(new Date(template.expires_at).getTime() / 1000).toBe(Number(template.expired_at_unix));
  });

  it("client 为零地址报错（没人注资的模板是废的）", () => {
    expect(() => buildReviewJobTemplate({ ...reviewJobParams(), client: ZERO_ADDRESS })).toThrow(
      InvalidReviewJobRolesError,
    );
  });

  it("client 与 provider 相同报错（委托人不能同时是受托方）", () => {
    expect(() => buildReviewJobTemplate({ ...reviewJobParams(), provider: MARKETPLACE })).toThrow(
      InvalidReviewJobRolesError,
    );
  });

  it("默认 description 不含禁用措辞（SA 措辞纪律覆盖到模板）", () => {
    const template = buildReviewJobTemplate(reviewJobParams());
    expect(() => {
      assertNoForbiddenWording(template);
    }).not.toThrow();
    expect(template.description.toLowerCase()).not.toContain("authoriz");
    expect(template.description).toContain("do not constitute legal advice");
  });

  it("模板可赋给开放记录（消费方按 Record 读也不会被破坏）", () => {
    const template = buildReviewJobTemplate(reviewJobParams());
    const asRecord: Readonly<Record<string, unknown>> = template;
    expect(asRecord["client"]).toBe(MARKETPLACE);
  });

  it("isReviewJobTemplate 认得自己产出的模板，认不得占位对象", () => {
    expect(isReviewJobTemplate(buildReviewJobTemplate(reviewJobParams()))).toBe(true);
    expect(isReviewJobTemplate({ kind: "counsel_review" })).toBe(false);
    expect(isReviewJobTemplate(null)).toBe(false);
  });
});

// ───────────────────────── 会谈卷宗 ─────────────────────────

describe("会谈卷宗：确定性事实段", () => {
  it("引用的判定项/法源/Module 版本全部来自入参，不是编的", () => {
    const pack = buildBriefingPack(briefingParams());
    expect(pack.facts.items).toEqual([ITEM]);
    expect(pack.facts.modules_used[0]?.version).toBe("2026.07.1");
    expect(pack.facts.rubric_version).toBe("2026.07");
    expect(pack.facts.items[0]?.source).toBe(ITEM.source);
  });

  it("卷宗不含材料原文，只有材料哈希（不变量 4 的同源纪律）", () => {
    const pack = buildBriefingPack(briefingParams());
    expect(pack.facts.material_sha256).toBe("cd".repeat(32));
    expect(JSON.stringify(pack)).not.toContain("compliance_note");
  });

  it("没有被升级的判定项就不该有卷宗", () => {
    expect(() => buildBriefingPack(briefingParams({ items: [] }))).toThrow(EmptyBriefingPackError);
  });

  it("带免责声明", () => {
    expect(buildBriefingPack(briefingParams()).disclaimer).toBe(BRIEFING_DISCLAIMER);
    expect(BRIEFING_DISCLAIMER).toContain("不构成法律意见");
    expect(BRIEFING_DISCLAIMER).toContain("由钱包按自有预设策略核验执行");
  });

  it("不含时间戳：同一案件两次生成的哈希逐字节相同（SA 要被签名与复算）", () => {
    const a = briefingPackHash(buildBriefingPack(briefingParams()));
    const b = briefingPackHash(buildBriefingPack(briefingParams()));
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("事实改一个字，哈希就变", () => {
    const base = briefingPackHash(buildBriefingPack(briefingParams()));
    const mutated = briefingPackHash(
      buildBriefingPack(briefingParams({ materialSha256: "ef".repeat(32) })),
    );
    expect(mutated).not.toBe(base);
  });
});

describe("会谈卷宗：LLM 叙述段没有改判空间", () => {
  const clean: BriefingNarrative = {
    summary:
      "The counterparty argues the transfer is incidental to a licensed advisory engagement; the regulator has not addressed this fact pattern directly.",
    questions_for_counsel: [
      "Does the advisory engagement independently exist without the transfer?",
      "Has any state regulator published guidance on this arrangement?",
    ],
  };

  it("干净叙述通过并被保留", () => {
    const pack = buildBriefingPack(briefingParams({ narrative: clean }));
    expect(pack.narrative).toEqual(clean);
  });

  it("不传叙述段时为 null（模板化最小版）", () => {
    expect(buildBriefingPack(briefingParams()).narrative).toBeNull();
  });

  it.each(["PASS", "HOLD", "ESCALATE"])("叙述里出现 %s 直接报错", (token) => {
    const narrative: BriefingNarrative = {
      ...clean,
      summary: `Recommend we mark this leg ${token} for now.`,
    };
    expect(() => {
      assertNarrativeIsNotDecisional(narrative);
    }).toThrow(DecisionalNarrativeError);
    expect(() => buildBriefingPack(briefingParams({ narrative }))).toThrow(
      DecisionalNarrativeError,
    );
  });

  it("questions_for_counsel 里出现决策词也拦住", () => {
    const narrative: BriefingNarrative = {
      ...clean,
      questions_for_counsel: ["Should this be ESCALATE or not?"],
    };
    expect(() => {
      assertNarrativeIsNotDecisional(narrative);
    }).toThrow(DecisionalNarrativeError);
  });

  it("小写的 hold 是正常英文动词，**不该**被误拦", () => {
    const narrative: BriefingNarrative = {
      ...clean,
      summary: "Funds are on hold pending the counsel meeting; no decision has been recorded.",
    };
    expect(() => {
      assertNarrativeIsNotDecisional(narrative);
    }).not.toThrow();
  });

  it("Passport / household 之类含子串的词不被误拦（用全词匹配）", () => {
    const narrative: BriefingNarrative = {
      ...clean,
      summary: "Passport copies and household registration documents were provided.",
    };
    expect(() => {
      assertNarrativeIsNotDecisional(narrative);
    }).not.toThrow();
  });
});

// ───────────────────────── 组装到 SA ─────────────────────────

describe("buildEscalation：SA 上那一份 + 落盘的卷宗正文", () => {
  it("escalation 只含模板与哈希，**不含卷宗正文**（链上只有哈希）", () => {
    const { escalation, briefingPack } = buildEscalation({
      briefing: briefingParams(),
      reviewJob: reviewJobParams(),
    });
    expect(Object.keys(escalation).sort()).toEqual(["briefing_pack_hash", "review_job_template"]);
    expect(escalation.briefing_pack_hash).toBe(briefingPackHash(briefingPack));
    expect(JSON.stringify(escalation)).not.toContain(ITEM.question);
  });

  it("专家能拿卷宗正文自己复算哈希、与 SA 上的比对", () => {
    const { escalation, briefingPack } = buildEscalation({
      briefing: briefingParams(),
      reviewJob: reviewJobParams(),
    });
    // 模拟第三方：只拿到正文，独立复算。
    expect(briefingPackHash(briefingPack)).toBe(escalation.briefing_pack_hash);
  });

  it("整个 escalation 过 SA 措辞纪律检查", () => {
    const { escalation } = buildEscalation({
      briefing: briefingParams(),
      reviewJob: reviewJobParams(),
    });
    expect(() => {
      assertNoForbiddenWording(escalation);
    }).not.toThrow();
  });
});
