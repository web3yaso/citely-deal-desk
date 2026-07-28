/**
 * 判定器输出的线上 JSON Schema —— **手写字面量常量**。
 *
 * 为什么必须手写而不是由 zod 之类转换（`docs/design/llm-provider-openai.md` §2.5）：
 * 这份 schema 的**字节**进 golden cache key。经第三方库生成会把缓存有效性绑到
 * 那个库的次要版本上，某天升级依赖就静默失效。
 *
 * wire ↔ domain（§2.1.1 W3 决策）：
 * - wire  : `gray_type: "data"|"interpretive"|"none"`（`"none"` 是 strict 模式所需哨兵值）
 * - domain: `gray_type?: "data"|"interpretive"`（合约 §4 原样，一个字节没变）
 */

import { sha256Canonical } from "../util/hash.js";

export type Verdict =
  | "confirmed_in_scope"
  | "confirmed_exempt"
  | "gray_data"
  | "gray_interpretive"
  | "unverifiable";

export type Confidence = "high" | "medium" | "low";
export type GrayType = "data" | "interpretive";
/** 线格式的 `gray_type`，比 domain 多一个哨兵值 `"none"`。 */
export type WireGrayType = GrayType | "none";

export const VERDICTS: readonly Verdict[] = [
  "confirmed_in_scope",
  "confirmed_exempt",
  "gray_data",
  "gray_interpretive",
  "unverifiable",
];

export const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

/** 引擎级兜底态：任何 rubric item 恒可取（§4.2）。 */
export const ENGINE_FALLBACK_VERDICTS: readonly Verdict[] = ["gray_data", "unverifiable"];

/** 合约 `contracts-vertical-slice.md` §4 —— domain 形态，逐字，不许增删字段。 */
export interface AdjudicationResult {
  readonly item_id: string;
  readonly verdict: Verdict;
  readonly confidence: Confidence;
  readonly source_refs: readonly string[];
  readonly risk_flags: readonly string[];
  readonly gray_type?: GrayType;
}

/** 线格式：`gray_type` 必填且可为 `"none"`。 */
export interface AdjudicationWire {
  readonly item_id: string;
  readonly verdict: Verdict;
  readonly confidence: Confidence;
  readonly source_refs: readonly string[];
  readonly risk_flags: readonly string[];
  readonly gray_type: WireGrayType;
}

export const ADJUDICATION_SCHEMA_NAME = "adjudication_v1";

/**
 * §4.1 定稿的 schema 常量。**改动即 golden cache 全量失效**，
 * 必须在录制 golden 之前定稿，之后不许再动。
 */
export const ADJUDICATION_JSON_SCHEMA = {
  name: ADJUDICATION_SCHEMA_NAME,
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id", "verdict", "confidence", "source_refs", "risk_flags", "gray_type"],
    properties: {
      item_id: { type: "string", description: "必须逐字等于被判定的 rubric item id" },
      verdict: {
        type: "string",
        enum: [
          "confirmed_in_scope",
          "confirmed_exempt",
          "gray_data",
          "gray_interpretive",
          "unverifiable",
        ],
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      source_refs: {
        type: "array",
        items: { type: "string" },
        description: "只允许逐字引用本 rubric item 的 source 字段中出现的法源标识",
      },
      risk_flags: { type: "array", items: { type: "string" } },
      gray_type: {
        type: "string",
        enum: ["data", "interpretive", "none"],
        description: "非灰色判定时必须为 none",
      },
    },
  },
} as const;

/**
 * schema 常量的规范化字节哈希，进 cache key（§4.3 的 `output_schema_sha256`）。
 * 哈希范围是 §4.1 的**整块**（含 `name` 与 `strict`）——它们同样影响线上行为。
 */
export const SCHEMA_SHA256: string = sha256Canonical(ADJUDICATION_JSON_SCHEMA);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** wire 形状的手写 type guard（§4.4 第 1 条）。语义校验在 `validate.ts`。 */
export function isAdjudicationWire(value: unknown): value is AdjudicationWire {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;

  const keys = Object.keys(obj).sort();
  const expected = [
    "confidence",
    "gray_type",
    "item_id",
    "risk_flags",
    "source_refs",
    "verdict",
  ];
  if (keys.length !== expected.length) return false;
  if (keys.some((k, i) => k !== expected[i])) return false;

  if (typeof obj["item_id"] !== "string") return false;
  if (!VERDICTS.includes(obj["verdict"] as Verdict)) return false;
  if (!CONFIDENCES.includes(obj["confidence"] as Confidence)) return false;
  if (!isStringArray(obj["source_refs"])) return false;
  if (!isStringArray(obj["risk_flags"])) return false;
  const grayType = obj["gray_type"];
  if (grayType !== "data" && grayType !== "interpretive" && grayType !== "none") return false;

  return true;
}

/**
 * wire → domain：把哨兵值 `"none"` 剥成"缺省键"。
 * 其余字段逐字保留，一个字节不改。
 */
export function toDomain(wire: AdjudicationWire): AdjudicationResult {
  const base = {
    item_id: wire.item_id,
    verdict: wire.verdict,
    confidence: wire.confidence,
    source_refs: wire.source_refs,
    risk_flags: wire.risk_flags,
  };
  // exactOptionalPropertyTypes 下不能写 `gray_type: undefined`，只能条件展开。
  return wire.gray_type === "none" ? base : { ...base, gray_type: wire.gray_type };
}

/** domain → wire：缺省键还原为哨兵值。用于把兜底/修正结果写回 golden 比对。 */
export function toWire(result: AdjudicationResult): AdjudicationWire {
  return {
    item_id: result.item_id,
    verdict: result.verdict,
    confidence: result.confidence,
    source_refs: result.source_refs,
    risk_flags: result.risk_flags,
    gray_type: result.gray_type ?? "none",
  };
}
