/**
 * provider 抽象层（`docs/design/llm-provider-openai.md` §3.2，接口原样）。
 *
 * **依赖方向纪律**：本目录下的一切**不认识 rubric、不认识 verdict、不认识 cache**。
 * 它只知道"给我 system 文本 + 数据对象 + JSON Schema，还我一个 JSON"。
 * 换回 Claude 只需新增一个实现文件，判定逻辑一行不改。
 */

/** 进入 cache key 的 provider 侧指纹。字段变化即缓存失效。 */
export interface LlmFingerprint {
  readonly provider: "openai" | "anthropic" | "fake";
  /** pin 到带日期的 snapshot，如 `gpt-5.6-luna-2026-xx-xx`。 */
  readonly model: string;
  /** `null` = 未发送该参数（如实记录，见 §2.3——不许假装设了一个没生效的参数）。 */
  readonly temperature: number | null;
  readonly reasoningEffort: string | null;
  readonly maxOutputTokens: number;
  /** Responses API 分支恒为 `null`。 */
  readonly seed: number | null;
}

/** 一次调用的可审计元数据。**不进 cache key**，进 golden 文件的 meta 段。 */
export interface LlmCallMeta {
  readonly requestId: string | null;
  /** 服务端回报的实际 model（与请求不同即告警：别名漂移会静默废掉 golden）。 */
  readonly model: string;
  readonly systemFingerprint: string | null;
  readonly usage: { input: number; output: number } | null;
  readonly latencyMs: number;
  readonly finishReason: string | null;
  readonly sdkVersion: string;
}

export interface JsonSchemaSpec {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export interface AdjudicationRequest {
  /** 唯一指令通道。由 rubric 渲染，**永不含材料内容**。 */
  readonly systemPrompt: string;
  /** 纯数据通道。沙箱输出，作为 JSON 值嵌入 user 消息，不做字符串拼接。 */
  readonly untrustedData: Readonly<Record<string, unknown>>;
  readonly outputSchema: JsonSchemaSpec;
}

export interface AdjudicationRaw {
  /** 已 `JSON.parse`、**未经语义校验**的 wire 对象。 */
  readonly json: unknown;
  readonly meta: LlmCallMeta;
}

export interface AdjudicatorLLM {
  /** 稳定标识，用于日志与 golden 目录分片，如 `openai:gpt-5.6-luna-2026-xx-xx`。 */
  readonly id: string;
  readonly fingerprint: LlmFingerprint;
  complete(req: AdjudicationRequest, opts?: { signal?: AbortSignal }): Promise<AdjudicationRaw>;
}
