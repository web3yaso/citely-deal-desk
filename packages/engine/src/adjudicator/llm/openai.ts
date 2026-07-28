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
 * 【待实测】spike ⑨ 需实机触发一次以确认真实响应确实走这条分支。
 */

import OpenAI from "openai";
import { VERSION as OPENAI_SDK_VERSION } from "openai/version";

import { createLogger } from "../../util/logger.js";
import {
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
 * 模型能力表。**当前全部为【待实测】的保守默认**，由 spike ⑨
 * （`packages/engine/scripts/probe-openai.ts`）实测后回填。
 *
 * 保守方向的含义：宁可**不发送** `temperature`，也不要发一个可能被 400 拒绝、
 * 或者发了却没生效的参数——后者会让我们在对外材料里声称一个假的确定性来源。
 */
export interface ModelCaps {
  readonly supportsTemperature: boolean;
  readonly supportsReasoningEffort: boolean;
}

/** 按模型 ID 前缀匹配（snapshot ID 带日期后缀，无法逐个枚举）。 */
export const MODEL_CAPS: readonly (readonly [prefix: string, caps: ModelCaps])[] = [
  // GPT-5.x 推理模型：最初对 temperature 报 400；effort=none 时是否放行【待实测】。
  ["gpt-5.6-", { supportsTemperature: false, supportsReasoningEffort: true }],
  ["gpt-5.4-", { supportsTemperature: false, supportsReasoningEffort: true }],
  ["gpt-5-", { supportsTemperature: false, supportsReasoningEffort: true }],
  // GPT-4.1 家族是非推理模型，采样参数语义传统（仅作 spike 对照组）。
  ["gpt-4.1", { supportsTemperature: true, supportsReasoningEffort: false }],
];

/** 未知模型的默认能力：两个参数都不发，指纹如实记 `null`。 */
export const DEFAULT_MODEL_CAPS: ModelCaps = {
  supportsTemperature: false,
  supportsReasoningEffort: false,
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

  private readonly client: OpenAI;
  private readonly caps: ModelCaps;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly effort: ReasoningEffort | null;

  public constructor(options: OpenAiAdjudicatorOptions) {
    this.caps = resolveModelCaps(options.model);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;

    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      // 重试自管：SDK 重试不受我们的错误分类控制，也不进日志。
      maxRetries: 0,
      timeout: this.timeoutMs,
    });

    this.effort = this.caps.supportsReasoningEffort
      ? toReasoningEffort(options.reasoningEffort ?? "none")
      : null;

    this.id = `openai:${options.model}`;
    this.fingerprint = {
      provider: "openai",
      model: options.model,
      temperature: this.caps.supportsTemperature ? (options.temperature ?? 0) : null,
      reasoningEffort: this.effort,
      maxOutputTokens: options.maxOutputTokens ?? 512,
      // Responses API 不支持 seed，如实记 null（§2.2）。
      seed: null,
    };
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
    // 材料在这里、且只在这里变成字符串：一次 JSON.stringify，无拼接。
    const userText = JSON.stringify(req.untrustedData);

    let response;
    try {
      response = await this.client.responses.create(
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
