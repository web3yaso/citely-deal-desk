/**
 * 判定器单元测试 U2–U8（`docs/design/llm-provider-openai.md` §8.1）。
 * 零网络、零 API key。
 */

import { describe, expect, it } from "vitest";

import type { RubricItem } from "../rubric/types.js";
import { sanitizeMaterial } from "../sandbox/index.js";
import type { SanitizedFacts } from "../sandbox/types.js";
import { computeCacheKey, FileGoldenCache, InMemoryGoldenCache } from "./cache.js";
import type { CacheKeyParts } from "./cache.js";
import {
  AdjudicatorUnavailableError,
  GoldenCacheMissError,
  LlmAuthError,
  LlmRefusalError,
  LlmSchemaError,
} from "./errors.js";
import { adjudicateItem, buildCacheKeyParts } from "./index.js";
import { FakeAdjudicatorLLM } from "./llm/fake.js";
import { createAdjudicatorLLM } from "./llm/factory.js";
import { OpenAiAdjudicatorLLM } from "./llm/openai.js";
import { AdjudicatorConfigError, modeRequiresNetwork, parseAdjudicatorMode } from "./modes.js";
import { buildUserPayloadObject, renderSystemPrompt } from "./prompt.js";
import {
  ADJUDICATION_JSON_SCHEMA,
  isAdjudicationWire,
  SCHEMA_SHA256,
  toDomain,
  toWire,
} from "./schema.js";
import { allowedVerdictsFor, buildFallbackResult, validateAdjudication } from "./validate.js";

const ITEM: RubricItem = {
  id: "MT-01",
  question: "是否构成 money transmitter？",
  signals: ["接收资金", "传输给第三方"],
  acceptance_criteria: ["两个动作都有证据"],
  common_rejection_reasons: ["只描述了收款"],
  source: "31 CFR § 1010.100(ff)(5)(i)(A) / FinCEN Guidance FIN-2019-G001",
  confidence_rule: "任一 signal 缺失 → gray_data",
};
const WHITELIST = ["31 CFR § 1010.100(ff)(5)(i)(A)", "FinCEN Guidance FIN-2019-G001"];
const RUBRIC = { id: "us-msb", version: "2026.07", verdict_states: ["confirmed_in_scope"] };

const FACTS: SanitizedFacts = sanitizeMaterial({
  fields: { evidence: { note: "counterparty is licensed" } },
});

function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: "MT-01",
    verdict: "confirmed_in_scope",
    confidence: "high",
    source_refs: [],
    risk_flags: [],
    gray_type: "none",
    ...over,
  };
}

function validate(raw: unknown, sandboxFlags: readonly string[] = []) {
  return validateAdjudication({
    wire: raw,
    itemId: "MT-01",
    allowedVerdicts: allowedVerdictsFor(RUBRIC.verdict_states),
    sourceWhitelist: WHITELIST,
    sandboxFlags,
  });
}

// ───────────────────────────── U2 schema ─────────────────────────────

describe("U2 schema", () => {
  it("SCHEMA_SHA256 快照——schema 一改即红（golden 全量失效的早期警报）", () => {
    expect(SCHEMA_SHA256).toMatchInlineSnapshot(
      `"14393ab9a53fe16cacef09dadbd164313af57b12207e1b4042f166bbd7babbf7"`,
    );
  });

  it("线上 schema 的 required 含全部 6 键，且 additionalProperties=false", () => {
    expect(ADJUDICATION_JSON_SCHEMA.schema.required).toEqual([
      "item_id",
      "verdict",
      "confidence",
      "source_refs",
      "risk_flags",
      "gray_type",
    ]);
    expect(ADJUDICATION_JSON_SCHEMA.schema.additionalProperties).toBe(false);
  });

  it("toDomain 剥离哨兵值 none，其余字段逐字保留", () => {
    const domain = toDomain({
      item_id: "MT-01",
      verdict: "confirmed_in_scope",
      confidence: "high",
      source_refs: ["a"],
      risk_flags: ["b"],
      gray_type: "none",
    });
    expect("gray_type" in domain).toBe(false);
    expect(domain.source_refs).toEqual(["a"]);
  });

  it("toDomain 保留真实 gray_type；toWire 往返还原", () => {
    const domain = toDomain({
      item_id: "MT-01",
      verdict: "gray_data",
      confidence: "low",
      source_refs: [],
      risk_flags: [],
      gray_type: "data",
    });
    expect(domain.gray_type).toBe("data");
    expect(toWire(domain).gray_type).toBe("data");
    expect(toWire({ ...domain, gray_type: undefined } as never).gray_type).toBe("none");
  });

  it.each([
    ["缺键", { item_id: "x" }],
    ["多键", wire({ extra: 1 })],
    ["verdict 越界", wire({ verdict: "totally_fine" })],
    ["confidence 越界", wire({ confidence: "very_high" })],
    ["gray_type 越界", wire({ gray_type: "maybe" })],
    ["source_refs 非字符串数组", wire({ source_refs: [1] })],
    ["顶层是数组", []],
    ["null", null],
  ])("isAdjudicationWire 拒绝 %s", (_name, raw) => {
    expect(isAdjudicationWire(raw)).toBe(false);
  });
});

// ───────────────────────────── U3 cache key ─────────────────────────────

describe("U3 computeKey", () => {
  const llm = new FakeAdjudicatorLLM();
  const base = buildCacheKeyParts(
    { caseId: "CASE-1", rubric: RUBRIC, item: ITEM, facts: FACTS },
    llm.fingerprint,
  );

  it("键字段任一变化 → key 变", () => {
    const mutations: readonly Partial<CacheKeyParts>[] = [
      { prompt_version: "other" },
      { prompt_template_sha256: "other" },
      { output_schema_sha256: "other" },
      { rubric_id: "other" },
      { rubric_version: "other" },
      { rubric_item_id: "other" },
      { rubric_item_sha256: "other" },
      { facts_sha256: "other" },
      { sandbox_flags_sha256: "other" },
      { llm: { ...llm.fingerprint, model: "other" } },
    ];
    for (const mutation of mutations) {
      expect(computeCacheKey({ ...base, ...mutation })).not.toBe(computeCacheKey(base));
    }
  });

  it("caseId 不进键", () => {
    const other = buildCacheKeyParts(
      { caseId: "CASE-999", rubric: RUBRIC, item: ITEM, facts: FACTS },
      llm.fingerprint,
    );
    expect(computeCacheKey(other)).toBe(computeCacheKey(base));
  });

  it("key 是 64 位十六进制", () => {
    expect(computeCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ───────────────────────────── U4 后置校验 ─────────────────────────────

describe("U4 validate 的 8 条检查", () => {
  it("① wire 形状错 → LlmSchemaError", () => {
    expect(() => validate({ nope: 1 })).toThrow(LlmSchemaError);
  });

  it("② item_id 不信任模型返回值，直接覆写", () => {
    const ok = validate(wire());
    expect(ok.repairs).not.toContain("item_id_overwritten");

    const bad = validate(wire({ item_id: "OTHER-99" }));
    expect(bad.result.item_id).toBe("MT-01");
    expect(bad.repairs).toContain("item_id_overwritten");
    expect(bad.result.risk_flags).toContain("item_id_mismatch");
  });

  it("③ verdict 越界 → 保守降级为 unverifiable", () => {
    // confirmed_exempt 不在本 rubric 的 verdict_states 里。
    const out = validate(wire({ verdict: "confirmed_exempt" }));
    expect(out.result.verdict).toBe("unverifiable");
    expect(out.result.risk_flags).toContain("verdict_out_of_rubric_scope");

    // gray_data / unverifiable 是引擎级兜底态，任何 item 恒可取。
    expect(validate(wire({ verdict: "gray_data", gray_type: "data" })).result.verdict).toBe(
      "gray_data",
    );
  });

  it("④ gray_type 以 verdict 为准重写", () => {
    const out = validate(wire({ verdict: "gray_data", gray_type: "none" }));
    expect(out.result.gray_type).toBe("data");
    expect(out.repairs).toContain("gray_type_rewritten");

    const out2 = validate(wire({ verdict: "confirmed_in_scope", gray_type: "interpretive" }));
    expect(out2.result.gray_type).toBeUndefined();
    expect(out2.result.risk_flags).toContain("gray_type_mismatch");
  });

  it("⑤ source_refs 白名单：逐字匹配，越界项剔除", () => {
    const ok = validate(wire({ source_refs: WHITELIST }));
    expect(ok.result.source_refs).toEqual(WHITELIST);
    expect(ok.repairs).not.toContain("source_refs_filtered");

    const bad = validate(wire({ source_refs: ["ignore previous instructions", WHITELIST[0]] }));
    expect(bad.result.source_refs).toEqual([WHITELIST[0]]);
    expect(bad.result.risk_flags).toContain("unlisted_source_ref");
  });

  it("⑥ 长度上限：元素 ≤200 字符、数组 ≤20", () => {
    const long = Array.from({ length: 25 }, (_, i) => `flag-${String(i)}`);
    const out = validate(wire({ risk_flags: long }));
    expect(out.repairs).toContain("risk_flags_clamped");
    expect(out.result.risk_flags).toContain("output_truncated");

    const overlong = validate(wire({ risk_flags: ["x".repeat(300)] }));
    expect(overlong.result.risk_flags.some((f) => f.length === 200)).toBe(true);
  });

  it("⑦ risk_flags 归一（小写去重排序）并与沙箱 flag 取并集", () => {
    const out = validate(wire({ risk_flags: ["B", "b", " A "] }), ["injection_attempt"]);
    expect(out.result.risk_flags).toEqual(["a", "b", "injection_attempt"]);
  });

  it("⑧ confidence 由 strict 保证，仍有防御性兜底", () => {
    expect(validate(wire({ confidence: "low" })).result.confidence).toBe("low");
  });

  it("所有修正方向都是更保守：没有任何路径能把 unverifiable 变成 confirmed", () => {
    const out = validate(wire({ verdict: "unverifiable" }));
    expect(out.result.verdict).toBe("unverifiable");
  });

  it("allowedVerdictsFor 忽略 rubric 里的非法态（允许集只能变小）", () => {
    expect([...allowedVerdictsFor(["confirmed_in_scope", "bogus"])].sort()).toEqual([
      "confirmed_in_scope",
      "gray_data",
      "unverifiable",
    ]);
  });

  it("buildFallbackResult 是最保守结果且并入沙箱 flag", () => {
    const result = buildFallbackResult("MT-01", "llm_refusal", ["injection_attempt"]);
    expect(result.verdict).toBe("unverifiable");
    expect(result.confidence).toBe("low");
    expect(result.source_refs).toEqual([]);
    expect(result.risk_flags).toEqual(["injection_attempt", "llm_refusal"]);
    expect(result.gray_type).toBeUndefined();
  });
});

// ───────────────────────────── U5 prompt ─────────────────────────────

describe("U5 prompt 通道分离", () => {
  it("renderSystemPrompt 输出不含任何材料字节", () => {
    const marker = "MATERIAL-CANARY-9137";
    const facts = sanitizeMaterial({ fields: { note: marker } });
    const prompt = renderSystemPrompt(ITEM);
    expect(prompt).not.toContain(marker);
    // 反证：材料确实携带该特征串。
    expect(JSON.stringify(buildUserPayloadObject(facts))).toContain(marker);
  });

  it("system prompt 含 rubric 内容与不可信材料条款", () => {
    const prompt = renderSystemPrompt(ITEM);
    expect(prompt).toContain(ITEM.id);
    expect(prompt).toContain(ITEM.question);
    expect(prompt).toContain("UNTRUSTED MATERIAL");
  });

  it("user 载荷顶层键为 untrusted_material / sandbox_flags", () => {
    const payload = buildUserPayloadObject(FACTS);
    expect(Object.keys(payload).sort()).toEqual(["sandbox_flags", "untrusted_material"]);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

// ───────────────────────────── U6 兜底 ─────────────────────────────

describe("U6 §4.5 兜底路径", () => {
  const input = { caseId: "CASE-1", rubric: RUBRIC, item: ITEM, facts: FACTS };

  it("refusal → unverifiable + llm_refusal，且**不写缓存**", async () => {
    const cache = new InMemoryGoldenCache();
    const llm = new FakeAdjudicatorLLM({ throws: () => new LlmRefusalError() });
    const envelope = await adjudicateItem(input, { llm, cache, mode: "cache_first" });
    expect(envelope.result.verdict).toBe("unverifiable");
    expect(envelope.result.risk_flags).toContain("llm_refusal");
    expect(envelope.provenance.repairs).toContain("fallback:llm_refusal");
    expect(cache.size).toBe(0);
  });

  it("重试耗尽 → unverifiable + adjudicator_unavailable", async () => {
    const llm = new FakeAdjudicatorLLM({
      throws: () => new AdjudicatorUnavailableError("retries exhausted"),
    });
    const envelope = await adjudicateItem(input, {
      llm,
      cache: new InMemoryGoldenCache(),
      mode: "live",
    });
    expect(envelope.result.risk_flags).toContain("adjudicator_unavailable");
    expect(envelope.provenance.meta).toBeNull();
  });

  it("wire 形状错先重试一次，仍失败 → llm_schema_error", async () => {
    const llm = new FakeAdjudicatorLLM({ fallbackWire: { nope: 1 } });
    const envelope = await adjudicateItem(input, {
      llm,
      cache: new InMemoryGoldenCache(),
      mode: "live",
    });
    expect(envelope.result.risk_flags).toContain("llm_schema_error");
    // 重试 1 次 = 一共调了 2 次。
    expect(llm.calls).toHaveLength(2);
  });
});

// ───────────────────────────── U7 factory ─────────────────────────────

describe("U7 createAdjudicatorLLM", () => {
  const MODEL = "gpt-5.6-luna-2026-05-13";

  it("缺 OPENAI_API_KEY 且模式需要联网 → 启动即失败，且消息不含任何密钥", () => {
    expect(() =>
      createAdjudicatorLLM({ OPENAI_MODEL: MODEL, ADJUDICATOR_MODE: "live" }),
    ).toThrow(AdjudicatorConfigError);
    try {
      createAdjudicatorLLM({ OPENAI_MODEL: MODEL, ADJUDICATOR_MODE: "live" });
    } catch (err) {
      expect((err as Error).message).toContain("OPENAI_API_KEY is required");
      expect((err as Error).message).not.toContain("sk-");
    }
  });

  it("cache_only 下缺 key 可正常构造（现场演示不联网）", () => {
    const llm = createAdjudicatorLLM({ OPENAI_MODEL: MODEL, ADJUDICATOR_MODE: "cache_only" });
    expect(llm.id).toBe(`openai:${MODEL}`);
    expect(llm.fingerprint.provider).toBe("openai");
  });

  it("OPENAI_MODEL 必须是带日期的 snapshot ID（别名漂移会静默废掉 golden）", () => {
    expect(() =>
      createAdjudicatorLLM({
        OPENAI_MODEL: "gpt-5.6-luna",
        OPENAI_API_KEY: "sk-test",
        ADJUDICATOR_MODE: "live",
      }),
    ).toThrow(/dated snapshot/);
  });

  it("缺 OPENAI_MODEL 直接失败", () => {
    expect(() => createAdjudicatorLLM({})).toThrow(AdjudicatorConfigError);
  });

  it("LLM_PROVIDER=fake 无需任何 key", () => {
    expect(createAdjudicatorLLM({ LLM_PROVIDER: "fake" }).fingerprint.provider).toBe("fake");
  });

  it("未知 provider 报错", () => {
    expect(() => createAdjudicatorLLM({ LLM_PROVIDER: "claude" })).toThrow(AdjudicatorConfigError);
  });

  it("非数字的 ADJUDICATOR_TIMEOUT_MS 报错", () => {
    expect(() =>
      createAdjudicatorLLM({
        OPENAI_MODEL: MODEL,
        OPENAI_API_KEY: "sk-test",
        ADJUDICATOR_TIMEOUT_MS: "soon",
      }),
    ).toThrow(AdjudicatorConfigError);
  });
});

// ─────────────────── MODEL_CAPS（spike ⑨ 实测结论的回归锁） ───────────────────

describe("MODEL_CAPS 与 temperature 发送策略（【已实测 2026-07-28】）", () => {
  const opts = { apiKey: "sk-test", timeoutMs: 1_000 };

  it("gpt-5.6-*：effort=none 时发 temperature（实测组合被接受）", () => {
    const llm = new OpenAiAdjudicatorLLM({ ...opts, model: "gpt-5.6-luna", temperature: 0 });
    expect(llm.fingerprint.reasoningEffort).toBe("none");
    expect(llm.fingerprint.temperature).toBe(0);
  });

  it("gpt-5.6-*：effort≠none 时**不发** temperature（单独发实测 400）", () => {
    const llm = new OpenAiAdjudicatorLLM({
      ...opts,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      temperature: 0,
    });
    expect(llm.fingerprint.reasoningEffort).toBe("medium");
    // 指纹如实记 null——不假装设了一个没发出去的参数。
    expect(llm.fingerprint.temperature).toBeNull();
  });

  it("gpt-5.4-*：temperature 无 effort 依赖", () => {
    const llm = new OpenAiAdjudicatorLLM({
      ...opts,
      model: "gpt-5.4-mini-2026-03-17",
      reasoningEffort: "medium",
      temperature: 0,
    });
    expect(llm.fingerprint.temperature).toBe(0);
  });

  it("未知模型：两个参数都不发，指纹全 null", () => {
    const llm = new OpenAiAdjudicatorLLM({ ...opts, model: "some-future-model", temperature: 0 });
    expect(llm.fingerprint.temperature).toBeNull();
    expect(llm.fingerprint.reasoningEffort).toBeNull();
  });

  it("Responses API 无 seed，指纹恒为 null", () => {
    expect(
      new OpenAiAdjudicatorLLM({ ...opts, model: "gpt-5.4-mini-2026-03-17" }).fingerprint.seed,
    ).toBeNull();
  });

  it("缺 key 时构造不抛错（cache_only 可用），但一旦真要调用就抛 LlmAuthError", async () => {
    const llm = new OpenAiAdjudicatorLLM({ apiKey: "", model: "gpt-5.4-mini-2026-03-17" });
    await expect(
      llm.complete({
        systemPrompt: "x",
        untrustedData: {},
        outputSchema: { name: "n", schema: {}, strict: true },
      }),
    ).rejects.toThrow(LlmAuthError);
  });
});

// ───────────────────────────── U8 模式语义 ─────────────────────────────

describe("U8 四种模式", () => {
  const input = { caseId: "CASE-1", rubric: RUBRIC, item: ITEM, facts: FACTS };

  it("parseAdjudicatorMode 缺省 cache_first，非法值报错", () => {
    expect(parseAdjudicatorMode(undefined)).toBe("cache_first");
    expect(parseAdjudicatorMode("")).toBe("cache_first");
    expect(() => parseAdjudicatorMode("turbo")).toThrow(AdjudicatorConfigError);
  });

  it("只有 cache_only 保证不联网", () => {
    expect(modeRequiresNetwork("cache_only")).toBe(false);
    for (const mode of ["cache_first", "record", "live"] as const) {
      expect(modeRequiresNetwork(mode)).toBe(true);
    }
  });

  it("cache_only 未命中 → GoldenCacheMissError，且 LLM 的 complete 从未被调用", async () => {
    const llm = new FakeAdjudicatorLLM();
    await expect(
      adjudicateItem(input, { llm, cache: new InMemoryGoldenCache(), mode: "cache_only" }),
    ).rejects.toThrow(GoldenCacheMissError);
    expect(llm.calls).toHaveLength(0);
  });

  it("cache_first：首次 miss 调 API 并写盘，第二次命中且不再调 API", async () => {
    const cache = new InMemoryGoldenCache();
    const llm = new FakeAdjudicatorLLM({ fixtures: { "MT-01": wire() } });
    const first = await adjudicateItem(input, { llm, cache, mode: "cache_first" });
    expect(first.provenance.cacheHit).toBe(false);
    expect(cache.size).toBe(1);

    const second = await adjudicateItem(input, { llm, cache, mode: "cache_first" });
    expect(second.provenance.cacheHit).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(second.result).toEqual(first.result);
  });

  it("cache_only 命中时输出与联网时逐字节相同（L1 承诺）", async () => {
    const cache = new InMemoryGoldenCache();
    const llm = new FakeAdjudicatorLLM({ fixtures: { "MT-01": wire() } });
    const online = await adjudicateItem(input, { llm, cache, mode: "cache_first" });
    const offline = await adjudicateItem(input, {
      llm: new FakeAdjudicatorLLM({ throws: () => new Error("network is down") }),
      cache,
      mode: "cache_only",
    });
    expect(JSON.stringify(offline.result)).toBe(JSON.stringify(online.result));
  });

  it("live 模式不读不写缓存", async () => {
    const cache = new InMemoryGoldenCache();
    const llm = new FakeAdjudicatorLLM({ fixtures: { "MT-01": wire() } });
    await adjudicateItem(input, { llm, cache, mode: "live" });
    expect(cache.size).toBe(0);
  });

  it("record 模式即使命中也重调并覆盖写", async () => {
    const cache = new InMemoryGoldenCache();
    const llm = new FakeAdjudicatorLLM({ fixtures: { "MT-01": wire() } });
    await adjudicateItem(input, { llm, cache, mode: "cache_first" });
    await adjudicateItem(input, { llm, cache, mode: "record" });
    expect(llm.calls).toHaveLength(2);
    expect(cache.size).toBe(1);
  });
});

// ───────────────────────────── FileGoldenCache ─────────────────────────────

describe("FileGoldenCache", () => {
  it("目录布局为 <dir>/<provider>/<model>/，未命中返回 null", () => {
    const cache = new FileGoldenCache({
      dir: "/tmp/citely-golden-test",
      provider: "openai",
      model: "gpt-5.6-luna-2026-05-13",
    });
    expect(cache.dir).toBe("/tmp/citely-golden-test");
    expect(cache.get("deadbeef")).toBeNull();
  });
});
