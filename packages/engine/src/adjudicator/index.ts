/**
 * 判定器唯一对外入口（`docs/design/llm-provider-openai.md` §3.3）。
 *
 * 串起：cache → llm → 确定性后置校验 → 兜底（§4.5），产出 {@link AdjudicationEnvelope}。
 *
 * **它产出的 `verdict` 不参与 `PASS/HOLD/ESCALATE` 的推导**（不变量 2）——
 * 那条公式在 `policy/condition.ts`，其入参类型里根本没有 verdict 的位置。
 */

import { parseSourceWhitelist } from "../rubric/index.js";
import type { RubricItem } from "../rubric/types.js";
import type { SanitizedFacts } from "../sandbox/types.js";
import { sha256Canonical } from "../util/hash.js";
import { createLogger } from "../util/logger.js";
import { computeCacheKey } from "./cache.js";
import type { CacheKeyParts, GoldenCache, GoldenEntry } from "./cache.js";
import { GoldenCacheMissError, LlmAuthError, LlmRefusalError, LlmSchemaError } from "./errors.js";
import type {
  AdjudicationRaw,
  AdjudicationRequest,
  AdjudicatorLLM,
  LlmCallMeta,
  LlmFingerprint,
} from "./llm/types.js";
import type { AdjudicatorMode } from "./modes.js";
import {
  buildUserPayloadObject,
  PROMPT_TEMPLATE_SHA256,
  PROMPT_VERSION,
  renderSystemPrompt,
} from "./prompt.js";
import {
  ADJUDICATION_JSON_SCHEMA,
  ADJUDICATION_SCHEMA_NAME,
  SCHEMA_SHA256,
} from "./schema.js";
import type { AdjudicationResult, Verdict } from "./schema.js";
import { allowedVerdictsFor, buildFallbackResult, validateAdjudication } from "./validate.js";
import type { FallbackReason, ValidateOutput } from "./validate.js";

const log = createLogger("adjudicator");

export type { AdjudicationResult, Confidence, GrayType, Verdict } from "./schema.js";
export type { AdjudicatorMode } from "./modes.js";

/** 包装层：证据链与可复现性元数据。**不属于合约 §4**，不进 SA 的 basis 对象。 */
export interface AdjudicationProvenance {
  readonly cacheKey: string;
  readonly cacheHit: boolean;
  readonly mode: AdjudicatorMode;
  readonly promptVersion: string;
  readonly schemaSha256: string;
  readonly rubric: { readonly id: string; readonly version: string; readonly itemSha256: string };
  readonly factsSha256: string;
  readonly llm: LlmFingerprint;
  /** 缓存命中时是 golden 文件里记录的历史 meta；兜底路径为 `null`。 */
  readonly meta: LlmCallMeta | null;
  /** 后置校验做过的确定性修正（§4.4）。 */
  readonly repairs: readonly string[];
}

export interface AdjudicationEnvelope {
  readonly result: AdjudicationResult;
  readonly provenance: AdjudicationProvenance;
}

/**
 * rubric 侧入参。
 *
 * 比设计 §3.3 的草图多一个 `verdict_states`：§4.2 的"允许集"判定需要它，
 * 而它是 rubric 级字段、不在 `RubricItem` 上。
 */
export interface AdjudicateRubricRef {
  readonly id: string;
  readonly version: string;
  readonly verdict_states: readonly string[];
}

export interface AdjudicateItemInput {
  /** 只用于日志与卷宗，**不进 cache key**（§4.3）。 */
  readonly caseId: string;
  readonly rubric: AdjudicateRubricRef;
  readonly item: RubricItem;
  readonly facts: SanitizedFacts;
}

export interface AdjudicatorDeps {
  readonly llm: AdjudicatorLLM;
  readonly cache: GoldenCache;
  readonly mode: AdjudicatorMode;
  /** 测试注入。 */
  readonly clock?: () => Date;
}

/** 构造 cache key 的全部材料（§4.3，字段集合一字不差）。 */
export function buildCacheKeyParts(
  input: AdjudicateItemInput,
  fingerprint: LlmFingerprint,
): CacheKeyParts {
  return {
    cache_schema_version: 1,
    prompt_version: PROMPT_VERSION,
    prompt_template_sha256: PROMPT_TEMPLATE_SHA256,
    output_schema_sha256: SCHEMA_SHA256,
    rubric_id: input.rubric.id,
    rubric_version: input.rubric.version,
    rubric_item_id: input.item.id,
    rubric_item_sha256: sha256Canonical(input.item),
    facts_sha256: sha256Canonical(input.facts.fields),
    // 注入版与干净版的 fields 可能几乎一致，沙箱 flag 不进键就会串缓存（§4.3）。
    sandbox_flags_sha256: sha256Canonical([...input.facts.detected_flags].sort()),
    llm: fingerprint,
  };
}

function buildRequest(input: AdjudicateItemInput): AdjudicationRequest {
  return {
    // 指令通道：只有 rubric，函数签名里连材料类型都没有。
    systemPrompt: renderSystemPrompt(input.item),
    // 数据通道：纯对象，序列化由 provider 在全仓唯一那一处完成。
    untrustedData: buildUserPayloadObject(input.facts),
    outputSchema: {
      name: ADJUDICATION_SCHEMA_NAME,
      schema: ADJUDICATION_JSON_SCHEMA.schema,
      strict: true,
    },
  };
}

/** 终局失败 → §4.5 兜底原因 flag。 */
function fallbackReasonFor(err: unknown): FallbackReason {
  if (err instanceof LlmRefusalError) return "llm_refusal";
  if (err instanceof LlmSchemaError) return "llm_schema_error";
  return "adjudicator_unavailable";
}

interface ValidationContext {
  readonly itemId: string;
  readonly allowedVerdicts: readonly Verdict[];
  readonly sourceWhitelist: readonly string[];
  readonly sandboxFlags: readonly string[];
}

function validateWire(wire: unknown, ctx: ValidationContext): ValidateOutput {
  return validateAdjudication({
    wire,
    itemId: ctx.itemId,
    allowedVerdicts: ctx.allowedVerdicts,
    sourceWhitelist: ctx.sourceWhitelist,
    sandboxFlags: ctx.sandboxFlags,
  });
}

/** 调 provider 一次；wire 形状错误按 §4.4 第 1 条**重试 1 次**，仍失败交给兜底。 */
async function callWithSchemaRetry(
  llm: AdjudicatorLLM,
  req: AdjudicationRequest,
  ctx: ValidationContext,
): Promise<{ readonly raw: AdjudicationRaw; readonly validated: ValidateOutput }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await llm.complete(req);
    try {
      return { raw, validated: validateWire(raw.json, ctx) };
    } catch (err) {
      // 只有"形状不对"值得再问一次；其余错误（refusal/auth/网络）重问也是同样结果。
      if (!(err instanceof LlmSchemaError)) throw err;
      lastError = err;
      log.warn("wire schema check failed, retrying once", {
        item_id: ctx.itemId,
        attempt: attempt + 1,
      });
    }
  }
  throw lastError instanceof Error ? lastError : new LlmSchemaError();
}

/**
 * golden 文件的 `key_inputs` 段：默认只存**哈希**。
 *
 * 仅当 `GOLDEN_STORE_PLAINTEXT=1`（合成案件专用）才附上 `fields` 明文，
 * 便于评委人工复算（§4.3 存储小节 / §10 Q6）。
 */
function goldenKeyInputs(
  parts: CacheKeyParts,
  input: AdjudicateItemInput,
): Readonly<Record<string, unknown>> {
  const base: Record<string, unknown> = { ...parts };
  if (process.env["GOLDEN_STORE_PLAINTEXT"] === "1") {
    base["fields_plaintext"] = input.facts.fields;
  }
  return base;
}

/**
 * 判定一条 rubric item。
 *
 * @param input - 案件、rubric、判定项与沙箱输出
 * @param deps - provider、golden cache、运行模式
 * @returns 判定结果 + 溯源信息
 * @throws {GoldenCacheMissError} `cache_only` 模式未命中——现场演示下
 *   "静默降级"比"响亮失败"危险得多
 */
export async function adjudicateItem(
  input: AdjudicateItemInput,
  deps: AdjudicatorDeps,
): Promise<AdjudicationEnvelope> {
  const parts = buildCacheKeyParts(input, deps.llm.fingerprint);
  const cacheKey = computeCacheKey(parts);
  const ctx: ValidationContext = {
    itemId: input.item.id,
    allowedVerdicts: allowedVerdictsFor(input.rubric.verdict_states),
    sourceWhitelist: parseSourceWhitelist(input.item.source),
    sandboxFlags: input.facts.detected_flags,
  };

  const provenanceBase = {
    cacheKey,
    mode: deps.mode,
    promptVersion: PROMPT_VERSION,
    schemaSha256: SCHEMA_SHA256,
    rubric: {
      id: input.rubric.id,
      version: input.rubric.version,
      itemSha256: parts.rubric_item_sha256,
    },
    factsSha256: parts.facts_sha256,
    llm: deps.llm.fingerprint,
  } as const;

  // ① 读缓存（`record`/`live` 不读）
  if (deps.mode === "cache_first" || deps.mode === "cache_only") {
    const hit = deps.cache.get(cacheKey);
    if (hit !== null) {
      // 缓存里存的是**未经校验的原始 wire**，读回来仍要过一遍后置校验：
      // 否则改 rubric 白名单后旧 golden 会绕过校验直接生效。
      const validated = validateWire(hit.wire, ctx);
      log.debug("golden cache hit", { item_id: input.item.id, cache_key: cacheKey });
      return {
        result: validated.result,
        provenance: {
          ...provenanceBase,
          cacheHit: true,
          meta: hit.meta,
          repairs: validated.repairs,
        },
      };
    }
    if (deps.mode === "cache_only") throw new GoldenCacheMissError(cacheKey);
  }

  // ② 调 provider
  try {
    const { raw, validated } = await callWithSchemaRetry(deps.llm, buildRequest(input), ctx);

    if (deps.mode === "cache_first" || deps.mode === "record") {
      const entry: GoldenEntry = {
        cache_key: cacheKey,
        key_inputs: goldenKeyInputs(parts, input),
        wire: raw.json,
        meta: raw.meta,
        recorded_at: (deps.clock?.() ?? new Date()).toISOString(),
      };
      deps.cache.put(entry);
    }

    return {
      result: validated.result,
      provenance: {
        ...provenanceBase,
        cacheHit: false,
        meta: raw.meta,
        repairs: validated.repairs,
      },
    };
  } catch (err) {
    // ③ §4.5 兜底：由确定性代码写死的最保守结果，**不写缓存**（否则错误被固化）。
    const reason = fallbackReasonFor(err);
    if (err instanceof LlmAuthError) {
      // 配置错误伪装成"暂时不可用"会让人查一天，所以单独响一声。
      log.error("adjudicator auth failure (check OPENAI_API_KEY configuration)", {
        item_id: input.item.id,
      });
    }
    log.warn("adjudication fell back to unverifiable", { item_id: input.item.id, reason });
    return {
      result: buildFallbackResult(input.item.id, reason, input.facts.detected_flags),
      provenance: {
        ...provenanceBase,
        cacheHit: false,
        meta: null,
        repairs: [`fallback:${reason}`],
      },
    };
  }
}
