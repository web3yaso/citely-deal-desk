/**
 * 沙箱解析器的数据契约（`docs/design/llm-provider-openai.md` §3.4）。
 *
 * 不变量 5 的落点：材料是**数据**不是指令。沙箱输出的 `SanitizedFacts`
 * 是材料能到达判定器的**唯一**形态，且只会作为 user 消息里的一个 JSON 值传入。
 */

/** 原始材料。`fields` 的值只允许 JSON 基本类型 / 数组 / 纯对象。 */
export interface RawMaterial {
  readonly fields: Readonly<Record<string, unknown>>;
}

/** 一次注入模式命中的证据。**不含原文**，只留哈希，便于审计与回归断言。 */
export interface SandboxDetection {
  /** 规则标识，如 `imperative_override`。 */
  readonly rule: string;
  /** 命中位置的字段路径，如 `evidence.note` 或 `parties.[0].role`。 */
  readonly field: string;
  /** 命中片段的 sha256（十六进制小写）。 */
  readonly excerpt_sha256: string;
}

export interface SanitizedFacts {
  /**
   * 结构化事实。值只允许 string | number | boolean | null 与其数组/嵌套对象；
   * 超长字段已截断（路径记入 `truncated_fields`）。
   */
  readonly fields: Readonly<Record<string, unknown>>;
  /** 沙箱确定性检测到的风险标记，如 `injection_attempt`（已去重排序）。 */
  readonly detected_flags: readonly string[];
  /** 命中注入模式的证据（去重后按 rule/field 排序）。 */
  readonly detections: readonly SandboxDetection[];
  /** 材料**原文**（截断前）规范化字节的哈希。进 SA / 链上的就是它。 */
  readonly material_sha256: string;
  /** 被截断的字段路径（已排序）。 */
  readonly truncated_fields: readonly string[];
}
