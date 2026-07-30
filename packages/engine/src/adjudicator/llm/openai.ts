/**
 * OpenAI provider 实现（`docs/design/llm-provider-openai.md` §2.1 / §2.2 / §7 第 3 组）。
 *
 * 端点：**Responses API** + `text.format = {type:"json_schema", strict:true}`。
 * 选它而不是 Chat Completions 的理由见 §2.2：我们的复现承诺建立在 golden cache 上，
 * 不建立在 `seed` 上，所以失去 `seed` 不构成实质损失。
 *
 * 本文件**不认识 rubric、不认识 verdict、不认识 cache**——它只把
 * "system 文本 + 数据对象 + JSON Schema" 换成一段 JSON。
 *
 * refusal 的确切位置（SDK 6.49.0 类型）：`response.output[]` 中 `type:"message"` 的项，
 * 其 `content[]` 元素可能是 `{type:"refusal", refusal:string}`。
 *
 * 【仍未实测 2026-07-28】spike ⑨ 用有害请求试过 `gpt-5.6-luna` 与
 * `gpt-5.4-mini-2026-03-17`，两次都返回 `message.content[].output_text`、
 * **没能触发 refusal 分支**——strict json_schema 下模型倾向于产出 schema 形状的输出
 * 而不是拒答。所以 {@link findRefusal} 依旧只有 SDK 类型定义作依据。
 *
 * 这条未知**不影响安全性**：万一真来了 refusal 而我们没认出来，
 * `output_text` 会是空串或非 JSON → `LlmSchemaError` → §4.5 兜底成
 * `unverifiable`。漏判的方向仍然是保守的，不会造成资金被错误放行。
 */

import OpenAI from "openai";
import { VERSION as OPENAI_SDK_VERSION } from "openai/version";

import { createLogger } from "../../util/logger.js";
import {
  AdjudicatorError,
  LlmAuthError,
  LlmRefusalError,
  LlmSchemaError,
  LlmTransientError,
} from "../errors.js";
import type {
  AdjudicationRaw,
  AdjudicationRequest,
  AdjudicatorLLM,
  LlmCallMeta,
  LlmFingerprint,
} from "./types.js";

const log = createLogger("adjudicator.openai");

/**
 * 模型能力表。**由 spike ⑨ 实测填写**
 * （`packages/engine/scripts/probe-openai.ts`，2026-07-28 实机跑过）。
 *
 * 保守方向的含义：宁可**不发送** `temperature`，也不要发一个会被 400 拒绝、
 * 或者发了却没生效的参数——后者会让我们在对外材料里声称一个假的确定性来源。
 */
export interface ModelCaps {
  readonly supportsTemperature: boolean;
  readonly supportsReasoningEffort: boolean;
  /**
   * `temperature` 是否**只在 `reasoning.effort="none"` 时**才被接受。
   *
   * 【已实测 2026-07-28】`gpt-5.6-luna`：单独发 `temperature=0` → 400
   * `Unsupported parameter: 'temperature' is not supported with this model.`；
   * 但 `effort=none` + `temperature=0` **组合被接受**。这不是一个布尔量能表达的
   * 能力，所以单列一条依赖——只写 `supportsTemperature:true` 会让
   * `OPENAI_REASONING_EFFORT=medium` 的人在演示当天吃 400。
   */
  readonly temperatureRequiresEffortNone: boolean;
}

/**
 * 按模型 ID 前缀匹配（snapshot ID 带日期后缀，无法逐个枚举）。
 *
 * 【已实测 2026-07-30，主导复跑 probe 确认】
 *
 * | 前缀 | effort=none | temperature=0 | 两者同发 | 备注 |
 * |---|---|---|---|---|
 * | `gpt-5.4-mini-2026-03-17` | ✅ | ✅ | ✅ | **当前主选**；该档 effort 默认即 none |
 * | `gpt-5.6-luna`（别名） | ✅ | ❌ 400 | ✅ | **无带日期 snapshot，不可用**，见下 |
 *
 * ⚠️ **`gpt-5.6` 家族在本 key 下没有任何带日期 snapshot**（`/v1/models` 只返回
 * `gpt-5.6-luna` / `sol` / `terra` 三个别名）。而 pin 到 snapshot 是硬要求
 * （别名漂移即 golden cache 静默失效，设计 §2.3 第 4 条），所以 5.6 家族
 * **在规则上不合格**——不是不想用，是没得 pin。主选据此降级为
 * `gpt-5.4-mini-2026-03-17`（设计 §2.3 的回退梯队第一档、§10 Q5 预设的动作）。
 *
 * 5.6 的能力项予以保留：它描述的行为是实测过的（`temperature` 只在
 * `effort=none` 时被接受），将来若出现带日期的 5.6 snapshot 可直接启用。
 */
export const MODEL_CAPS: readonly (readonly [prefix: string, caps: ModelCaps])[] = [
  [
    "gpt-5.6-",
    { supportsTemperature: true, supportsReasoningEffort: true, temperatureRequiresEffortNone: true },
  ],
  [
    // 【实测修正 2026-07-30】此前写的是 `temperatureRequiresEffortNone: false`，**错的**。
    // probe 当时只测了"仅 temperature=0"（不带 effort）与"effort=none + temperature=0"，
    // 两者都过，于是被读成"temperature 无 effort 依赖"。但补测
    // **effort=medium/high + temperature=0 → 400 Unsupported parameter: 'temperature'**。
    // 5.4 与 5.6 在这一点上行为一致：temperature 只在 effort 为 none 或不发时被接受。
    "gpt-5.4-",
    { supportsTemperature: true, supportsReasoningEffort: true, temperatureRequiresEffortNone: true },
  ],
  // 未实测，按 5.6 的保守形态处理。
  [
    "gpt-5-",
    { supportsTemperature: true, supportsReasoningEffort: true, temperatureRequiresEffortNone: true },
  ],
  // GPT-4.1 家族是非推理模型，采样参数语义传统（仅作 spike 对照组）。
  [
    "gpt-4.1",
    {
      supportsTemperature: true,
      supportsReasoningEffort: false,
      temperatureRequiresEffortNone: false,
    },
  ],
];

/**
 * 默认输出预算。
 *
 * 设计 §2.3：`max_output_tokens = 512` 的前提是 `effort=none`（**reasoning tokens
 * 计入输出预算**）；"若被迫用 `effort>=low`，须提到 ≥ 2048 并重录 golden"。
 * 这条以前只写在文档里，靠人记得——现在落成代码，免得 effort 一调高就静默截断
 * （截断表现为 `response.status="incomplete"` → LlmSchemaError → 兜底 unverifiable，
 * 又是一次"看起来在跑其实全是兜底"）。
 */
export function defaultMaxOutputTokens(effort: string | null): number {
  return effort === null || effort === "none" ? 512 : 2048;
}

/** 未知模型的默认能力：两个参数都不发，指纹如实记 `null`。 */
export const DEFAULT_MODEL_CAPS: ModelCaps = {
  supportsTemperature: false,
  supportsReasoningEffort: false,
  temperatureRequiresEffortNone: false,
};

export function resolveModelCaps(model: string): ModelCaps {
  for (const [prefix, caps] of MODEL_CAPS) {
    if (model.startsWith(prefix)) return caps;
  }
  return DEFAULT_MODEL_CAPS;
}

export interface OpenAiAdjudicatorOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  /** 测试注入：跳过真实等待。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 退避序列（§7 第 3 组：250ms / 1s / 4s + jitter），共 3 次重试。 */
const BACKOFF_MS: readonly number[] = [250, 1_000, 4_000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // 网络层错误，无状态码
  return status === 408 || status === 429 || status >= 500;
}

/** SDK 的 `Shared.ReasoningEffort` 取值集合，用于收窄字符串 env 值。 */
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 把任意字符串收窄为合法 effort；不认识的值返回 `null`（即"不发送该参数"）。 */
export function toReasoningEffort(value: string): ReasoningEffort | null {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : null;
}

/** 从 `response.output[]` 里挖出 refusal 文本；没有则返回 `null`。 */
function findRefusal(output: readonly unknown[]): string | null {
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record["type"] !== "message") continue;
    const content = record["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const partRecord = part as Record<string, unknown>;
      if (partRecord["type"] === "refusal" && typeof partRecord["refusal"] === "string") {
        return partRecord["refusal"];
      }
    }
  }
  return null;
}

export class OpenAiAdjudicatorLLM implements AdjudicatorLLM {
  public readonly id: string;
  public readonly fingerprint: LlmFingerprint;

  private readonly options: OpenAiAdjudicatorOptions;
  private readonly caps: ModelCaps;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly effort: ReasoningEffort | null;
  /** 懒建，见 {@link OpenAiAdjudicatorLLM.getClient}。 */
  private client: OpenAI | null = null;

  public constructor(options: OpenAiAdjudicatorOptions) {
    this.options = options;
    this.caps = resolveModelCaps(options.model);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;

    this.effort = this.caps.supportsReasoningEffort
      ? toReasoningEffort(options.reasoningEffort ?? "none")
      : null;

    this.id = `openai:${options.model}`;
    this.fingerprint = {
      provider: "openai",
      model: options.model,
      temperature: this.resolveTemperature(options.temperature),
      reasoningEffort: this.effort,
      maxOutputTokens: options.maxOutputTokens ?? defaultMaxOutputTokens(this.effort),
      // Responses API 不支持 seed，如实记 null（§2.2）。
      seed: null,
    };
  }

  /**
   * 决定要不要发 `temperature`，`null` = 不发。
   *
   * `null` 会如实进 cache key 指纹——我们不假装设了一个没生效的参数（§2.3）。
   * 对外话术只用 §2.4 的 L1/L2/L3 等级，不说"temperature=0 保证确定性"。
   */
  private resolveTemperature(requested: number | undefined): number | null {
    if (!this.caps.supportsTemperature) return null;
    // 实测：5.6 家族只在 effort=none 时接受 temperature，否则 400。
    if (this.caps.temperatureRequiresEffortNone && this.effort !== "none") return null;
    return requested ?? 0;
  }

  /**
   * SDK 客户端**懒建**。
   *
   * 原因：`ADJUDICATOR_MODE=cache_only`（现场演示、无 key CI）必须能正常构造本实例，
   * 而 SDK 在构造时就会因为缺 key 抛错。这条路径根本不会走到 `complete()`，
   * 所以把"缺 key"推迟到真的要联网的那一刻才失败——
   * 且失败成我们自己的 {@link LlmAuthError}，而不是 SDK 的原始错误（它可能回显配置）。
   */
  private getClient(): OpenAI {
    if (this.client !== null) return this.client;
    if (this.options.apiKey.trim() === "") {
      throw new LlmAuthError("OPENAI_API_KEY is not configured (only cache_only runs offline)");
    }
    this.client = new OpenAI({
      apiKey: this.options.apiKey,
      ...(this.options.baseURL === undefined ? {} : { baseURL: this.options.baseURL }),
      // 重试自管：SDK 重试不受我们的错误分类控制，也不进日志。
      maxRetries: 0,
      timeout: this.timeoutMs,
    });
    return this.client;
  }

  public async complete(
    req: AdjudicationRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<AdjudicationRaw> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
      try {
        return await this.callOnce(req, opts);
      } catch (err) {
        // refusal / schema / auth 都是确定性失败，重试没有意义。
        if (!(err instanceof LlmTransientError)) throw err;
        lastError = err;
        const delay = BACKOFF_MS[attempt];
        if (delay === undefined) break;
        const jitter = Math.floor(Math.random() * 100);
        log.warn("transient failure, backing off", {
          attempt: attempt + 1,
          status: err.status,
          delay_ms: delay + jitter,
        });
        await this.sleep(delay + jitter);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LlmTransientError("openai call failed", null);
  }

  private async callOnce(
    req: AdjudicationRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<AdjudicationRaw> {
    const startedAt = Date.now();
    // ⚠️ 全仓**唯一**的材料序列化点（不变量 5 的审查点，合约 §4）。
    // 一次 `JSON.stringify`，无任何 `+` 拼接、无模板插值、无自然语言前缀。
    // `prompt.ts` 刻意只返回对象、不返回字符串，就是为了让这句话成立。
    // 想在别处把材料变成字符串，先来改这条注释并说服审查者。
    const userText = JSON.stringify(req.untrustedData);

    let response;
    try {
      response = await this.getClient().responses.create(
        {
          model: this.fingerprint.model,
          instructions: req.systemPrompt,
          input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
          text: {
            format: {
              type: "json_schema",
              name: req.outputSchema.name,
              schema: { ...req.outputSchema.schema },
              strict: true,
            },
          },
          max_output_tokens: this.fingerprint.maxOutputTokens,
          ...(this.fingerprint.temperature === null
            ? {}
            : { temperature: this.fingerprint.temperature }),
          ...(this.effort === null ? {} : { reasoning: { effort: this.effort } }),
        },
        opts?.signal === undefined ? {} : { signal: opts.signal },
      );
    } catch (err) {
      throw this.classifyError(err);
    }

    const refusal = findRefusal(response.output);
    if (refusal !== null) {
      // refusal 文本本身不记日志：它可能复述材料内容。
      throw new LlmRefusalError();
    }

    if (response.status === "incomplete") {
      throw new LlmSchemaError(
        `response incomplete: ${response.incomplete_details?.reason ?? "unknown"}`,
      );
    }

    if (response.model !== this.fingerprint.model) {
      // 别名漂移会静默废掉整批 golden，必须告警。
      log.warn("model drift: server returned a different model", {
        requested: this.fingerprint.model,
        returned: response.model,
      });
    }

    const text = response.output_text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new LlmSchemaError("model output is not valid JSON", { cause: err });
    }

    const meta: LlmCallMeta = {
      requestId: response.id,
      model: response.model,
      // Responses API 无 system_fingerprint（§2.2）。
      systemFingerprint: null,
      usage:
        response.usage === undefined
          ? null
          : { input: response.usage.input_tokens, output: response.usage.output_tokens },
      latencyMs: Date.now() - startedAt,
      finishReason: response.status ?? null,
      sdkVersion: OPENAI_SDK_VERSION,
    };

    return { json, meta };
  }

  /** HTTP/网络错误 → 类型化错误。**任何分支都不回显 API key**。 */
  private classifyError(err: unknown): Error {
    // 已经是我们自己的类型化错误（如懒建时的 LlmAuthError）就原样上抛，
    // 否则会被降级成"暂时性失败"而白白重试 3 次。
    if (err instanceof AdjudicatorError) return err;
    if (err instanceof OpenAI.APIError) {
      const status = err.status;
      if (status === 401 || status === 403) {
        return new LlmAuthError(`openai auth failed (status ${String(status)})`);
      }
      if (isRetriableStatus(status)) {
        return new LlmTransientError(
          `openai transient failure (status ${String(status)})`,
          status ?? null,
          { cause: err },
        );
      }
      // 400 等：schema 不被 strict 子集接受之类，开发期一次性暴露，不重试。
      return new LlmSchemaError(`openai rejected the request (status ${String(status)})`, {
        cause: err,
      });
    }
    return new LlmTransientError("openai call failed at transport layer", null, { cause: err });
  }
}
