/**
 * 判定器的类型化错误（`docs/design/llm-provider-openai.md` §7 第 3 组）。
 *
 * 纪律：错误信息里**不出现密钥、不出现材料内容**。需要定位时只带
 * `cache_key` / `item_id` / HTTP 状态码这类非敏感上下文。
 */

/** 所有判定器错误的基类，便于调用方一把 catch。 */
export class AdjudicatorError extends Error {
  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "AdjudicatorError";
  }
}

/** 模型拒答（Structured Outputs 的 refusal 通道）。**不重试**。 */
export class LlmRefusalError extends AdjudicatorError {
  public constructor(message = "model refused to answer") {
    super(message);
    this.name = "LlmRefusalError";
  }
}

/** 可重试的暂时性失败：429 / 5xx / 网络错 / 超时。 */
export class LlmTransientError extends AdjudicatorError {
  public readonly status: number | null;

  public constructor(message: string, status: number | null, options?: { cause: unknown }) {
    super(message, options);
    this.name = "LlmTransientError";
    this.status = status;
  }
}

/** 返回体不符合线上 schema（strict 理应挡住，兜底仍要有）。 */
export class LlmSchemaError extends AdjudicatorError {
  public constructor(message = "model output failed wire schema check", options?: { cause: unknown }) {
    super(message, options);
    this.name = "LlmSchemaError";
  }
}

/** 401/403 或缺少 API key。**不重试**，且消息里绝不回显 key。 */
export class LlmAuthError extends AdjudicatorError {
  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "LlmAuthError";
  }
}

/** `cache_only` 模式未命中。演示模式下必须响亮失败，不许静默降级。 */
export class GoldenCacheMissError extends AdjudicatorError {
  public readonly cacheKey: string;

  public constructor(cacheKey: string) {
    super(`golden cache miss in cache_only mode: ${cacheKey}`);
    this.name = "GoldenCacheMissError";
    this.cacheKey = cacheKey;
  }
}

/** 重试耗尽后的终局不可用。触发 §4.5 兜底。 */
export class AdjudicatorUnavailableError extends AdjudicatorError {
  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "AdjudicatorUnavailableError";
  }
}
