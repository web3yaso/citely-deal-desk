/**
 * `exit4-review-job.ts` 里纯函数的单测（零网络、零私钥）。
 *
 * 真链那部分只有 `--live` 能验；但**角色映射与有效期这两类断言本身**必须先被测到——
 * 它们是"花钱之前的最后一道闸"，闸自己写错了不会有任何人报错。
 *
 * ⚠️ 本目录不在任何 workspace 包里，`pnpm test` 不会跑到它。手动跑：
 * `pnpm exec vitest run scripts/spike/exit4-review-job.test.ts`
 */
import { describe, expect, it } from "vitest";

import { buildReviewJobTemplate } from "../../packages/engine/src/escalation/review-job.js";
import type { ReviewJobTemplate } from "../../packages/engine/src/escalation/review-job.js";
import { routeExit } from "../../packages/engine/src/routing/index.js";
import { toRoutingSummaries } from "../../packages/engine/src/orchestrator/stages.js";
import { loadRubric } from "../../packages/engine/src/rubric/index.js";
import { usdc6 } from "../../packages/engine/src/util/usdc6.js";
import type { Address } from "../../packages/chain/src/types/viem.js";
import type { JobFeeRates } from "../../packages/chain/src/types/job.js";
import {
  fixtureAdjudications,
  interpretiveGrayDeal,
  isEntrypoint,
  isSameTemplate,
  moduleResponseFixture,
  nativeToUsdc6,
  reviewDeliverableHash,
  reviewJobTemplateChecks,
  settlementExpectation,
  walletFundingChecks,
  type ExpectedReviewRoles,
} from "./exit4-review-job.js";

const RUBRIC = loadRubric(new URL("../../rubrics/us-msb.json", import.meta.url).pathname);

const MARKETPLACE = "0x1111111111111111111111111111111111111111" as Address;
const EXPERT = "0x2222222222222222222222222222222222222222" as Address;
const VERIFIER = "0x3333333333333333333333333333333333333333" as Address;
const OPERATOR = "0x4444444444444444444444444444444444444444" as Address;

/** 链上时间锚点与到期时刻：全部固定值，测试里不许出现墙上时钟。 */
const CHAIN_NOW = 1_800_000_000n;
const EXPIRED_AT = CHAIN_NOW + 600n;
const DEPOSIT = 50_000n;

function template(overrides: Partial<{ expiresAt: Date; client: Address; provider: Address }> = {}): ReviewJobTemplate {
  return buildReviewJobTemplate({
    client: overrides.client ?? MARKETPLACE,
    provider: overrides.provider ?? EXPERT,
    evaluator: VERIFIER,
    expiresAt: overrides.expiresAt ?? new Date(Number(EXPIRED_AT) * 1000),
    deposit: usdc6(DEPOSIT),
    escalatedItemIds: ["MT-01"],
  });
}

const EXPECTED: ExpectedReviewRoles = {
  marketplace: MARKETPLACE,
  expert: EXPERT,
  verifier: VERIFIER,
  operator: OPERATOR,
  expiredAt: EXPIRED_AT,
  chainNow: CHAIN_NOW,
  deposit: DEPOSIT,
};

function failed(checks: readonly { readonly label: string; readonly ok: boolean }[]): readonly string[] {
  return checks.filter((c) => !c.ok).map((c) => c.label);
}

describe("interpretiveGrayDeal / fixtureAdjudications", () => {
  it("构造出的案件路由到出口 4，且升级清单只含那一条解释性 gray", () => {
    const items = fixtureAdjudications(RUBRIC, "MT-01");
    const input = {
      intake: "ok" as const,
      expired: false,
      adjudications: toRoutingSummaries(items, true),
    };

    expect(routeExit(input).exit).toBe("interpretive_gray");
    expect(items.filter((i) => i.gray_type === "interpretive").map((i) => i.item_id)).toEqual(["MT-01"]);
  });

  it("卷宗里的法源取自 rubric 原文，不是手写字符串", () => {
    const items = fixtureAdjudications(RUBRIC, "MT-01");
    const mt01 = items.find((i) => i.item_id === "MT-01");
    expect(mt01?.source).toBe(RUBRIC.rubric.items.find((i) => i.id === "MT-01")?.source);
  });

  it("案件材料非空且是解释性争议（不是数据缺口）", () => {
    const deal = interpretiveGrayDeal("case-1");
    expect(deal.evidence["fincen_msb_registration"]).toBe("registered");
    expect(String(deal.evidence["compliance_note"])).toContain("disagree");
  });

  it("Module fixture 的 evaluated_check_count 不为 0（0 表示压根没被评估过）", () => {
    expect(moduleResponseFixture("case-1").settlement_constraints.evaluated_check_count).toBe(1);
  });
});

describe("reviewJobTemplateChecks", () => {
  it("角色、时刻、金额都对时全部通过", () => {
    expect(failed(reviewJobTemplateChecks(template(), EXPECTED))).toEqual([]);
  });

  it("client 填成 Citely 运营地址时报错（我方替客户付专家酬金）", () => {
    const checks = reviewJobTemplateChecks(template({ client: OPERATOR }), EXPECTED);
    expect(failed(checks)).toContain(
      "client **不是** Citely 运营地址（否则等于我方替客户付专家酬金）",
    );
  });

  it("provider 不是专家钱包时报错", () => {
    const other = "0x5555555555555555555555555555555555555555" as Address;
    expect(failed(reviewJobTemplateChecks(template({ provider: other }), EXPECTED))).toContain(
      "provider 是专家钱包",
    );
  });

  it("专家钱包被填成运营钱包时报错（Citely 评审自己）", () => {
    const checks = reviewJobTemplateChecks(template({ provider: OPERATOR }), {
      ...EXPECTED,
      expert: OPERATOR,
    });
    expect(failed(checks)).toEqual([
      "provider **不是** Citely 运营地址（否则等于我方评审我方自己的判定）",
    ]);
  });

  it("到期余量不足 5 分钟时报错（链上 ExpiryTooShort 下限）", () => {
    const tooSoon = CHAIN_NOW + 60n;
    const checks = reviewJobTemplateChecks(template({ expiresAt: new Date(Number(tooSoon) * 1000) }), {
      ...EXPECTED,
      expiredAt: tooSoon,
    });
    expect(failed(checks)).toContain("到期余量 > 300 秒（链上 ExpiryTooShort 下限）");
  });

  it("模板的到期时刻与将传给 createJob 的值不一致时报错", () => {
    const checks = reviewJobTemplateChecks(template(), { ...EXPECTED, expiredAt: EXPIRED_AT + 1n });
    expect(failed(checks)).toContain("expired_at_unix 与将传给 createJob 的值逐字一致");
  });

  it("保证金与模板不一致时报错", () => {
    expect(failed(reviewJobTemplateChecks(template(), { ...EXPECTED, deposit: 1n }))).toContain(
      "deposit_nominal 与将要注资的金额一致",
    );
  });
});

describe("isSameTemplate", () => {
  it("同一锚点两次组装逐字相同", () => {
    expect(isSameTemplate(template(), template())).toBe(true);
  });

  it("到期时刻取墙上时钟时两次组装不同", () => {
    const a = template({ expiresAt: new Date(1_800_000_000_000) });
    const b = template({ expiresAt: new Date(1_800_000_001_000) });
    expect(isSameTemplate(a, b)).toBe(false);
  });
});

describe("walletFundingChecks", () => {
  const wallet = (over: Partial<{ native: bigint; token: bigint; minToken: bigint }>) => ({
    role: "专家",
    address: EXPERT,
    native: over.native ?? 10n ** 18n,
    token: over.token ?? 0n,
    minNative: 10n ** 16n,
    minToken: over.minToken ?? 0n,
  });

  it("gas 足够且不需要出钱时通过", () => {
    expect(failed(walletFundingChecks([wallet({})]))).toEqual([]);
  });

  it("专家没有 gas 时报错——setBudget 只有 provider 能调，它必须自己发交易", () => {
    expect(failed(walletFundingChecks([wallet({ native: 0n })]))).toHaveLength(1);
  });

  it("出资方 USDC 不足时报错，且不足的提示里带 faucet", () => {
    const checks = walletFundingChecks([wallet({ token: 10n, minToken: DEPOSIT })]);
    const bad = checks.filter((c) => !c.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.detail).toContain("https://faucet.circle.com");
  });
});

describe("settlementExpectation", () => {
  it("零费率时保证金全额归专家", () => {
    const fees: JobFeeRates = { platformFeeBP: 0n, evaluatorFeeBP: 0n };
    expect(settlementExpectation(DEPOSIT, fees)).toEqual({
      client: -DEPOSIT,
      provider: DEPOSIT,
      evaluator: 0n,
    });
  });

  it("有费率时按链上 bp 拆分，三方之和等于保证金", () => {
    const fees: JobFeeRates = { platformFeeBP: 100n, evaluatorFeeBP: 200n };
    const e = settlementExpectation(DEPOSIT, fees);
    expect(e.provider).toBe(DEPOSIT - 500n - 1_000n);
    expect(e.evaluator).toBe(1_000n);
    expect(-e.client).toBeGreaterThan(e.provider + e.evaluator);
  });
});

describe("reviewDeliverableHash", () => {
  const outcome = {
    case_id: "exit4-1",
    reviewed_item_ids: ["MT-01"],
    briefing_pack_hash: "0xabc",
    reviewer_note: "Interpretive review completed.",
  };

  it("同样输入得到同样哈希，且是 32 字节 0x 前缀", () => {
    const hash = reviewDeliverableHash(outcome);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reviewDeliverableHash({ ...outcome })).toBe(hash);
  });

  it("正文变一个字，哈希就变", () => {
    expect(reviewDeliverableHash({ ...outcome, reviewer_note: "x" })).not.toBe(
      reviewDeliverableHash(outcome),
    );
  });
});

describe("nativeToUsdc6", () => {
  it("18 位原生币折算成 6 位 USDC", () => {
    expect(nativeToUsdc6(10n ** 18n)).toBe(1_000_000n);
    expect(nativeToUsdc6(10n ** 12n)).toBe(1n);
  });
});

describe("isEntrypoint", () => {
  it("被 node 直接执行时为真", () => {
    expect(isEntrypoint("/repo/scripts/spike/exit4-review-job.ts", "file:///repo/scripts/spike/exit4-review-job.ts")).toBe(true);
  });

  it("被别的模块 import（例如本测试）时为假", () => {
    expect(isEntrypoint("/repo/node_modules/.bin/vitest", "file:///repo/scripts/spike/exit4-review-job.ts")).toBe(false);
    expect(isEntrypoint(undefined, "file:///repo/scripts/spike/exit4-review-job.ts")).toBe(false);
  });
});
