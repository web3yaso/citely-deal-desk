/**
 * 确定性后置校验（`docs/design/llm-provider-openai.md` §4.4）。
 *
 * strict json_schema 只保证**语法/结构**，它不知道 `source_refs` 是不是真的
 * 出自本条 rubric。这一层补的就是语义。
 *
 * **本文件的每一条修正方向都是"更保守/更少断言"，没有任何放宽路径。**
 * 这是"即使模型被完全策反系统依然安全"的第一道确定性防线（第二道是
 * Policy Engine 根本不读 verdict）。
 */

import { LlmSchemaError } from "./errors.js";
import {
  ENGINE_FALLBACK_VERDICTS,
  type AdjudicationResult,
  type AdjudicationWire,
  type Confidence,
  type GrayType,
  type Verdict,
  CONFIDENCES,
  isAdjudicationWire,
  toDomain,
} from "./schema.js";

/** 单个 `source_refs`/`risk_flags` 元素的最大字符数（§4.4 第 6 条）。 */
export const MAX_LIST_ITEM_CHARS = 200;
/** `source_refs`/`risk_flags` 的最大元素数（§4.4 第 6 条）。 */
export const MAX_LIST_LENGTH = 20;

export interface ValidateInput {
  /** LLM 返回的、已 `JSON.parse` 的原始 wire 对象。 */
  readonly wire: unknown;
  /** 本次请求的 rubric item id —— **以它为准**，不信任模型返回值。 */
  readonly itemId: string;
  /** 本 item 允许的 verdict 集合（rubric.verdict_states ∪ 引擎兜底态）。 */
  readonly allowedVerdicts: readonly Verdict[];
  /** 本 item 的法源白名单（由 rubric `source` 字段解析）。 */
  readonly sourceWhitelist: readonly string[];
  /** 沙箱确定性检测到的 flag，与模型自报取并集（§6.3 第 3 条）。 */
  readonly sandboxFlags: readonly string[];
}

export interface ValidateOutput {
  readonly result: AdjudicationResult;
  /** 做过的确定性修正，逐条记入 `provenance.repairs`。 */
  readonly repairs: readonly string[];
}

/** rubric 的 3 态 + 引擎兜底 2 态 = 本 item 的允许集（§4.2）。 */
export function allowedVerdictsFor(rubricVerdictStates: readonly string[]): readonly Verdict[] {
  const allowed = new Set<Verdict>(ENGINE_FALLBACK_VERDICTS);
  for (const state of rubricVerdictStates) {
    // rubric 里出现的非法态直接忽略：允许集只能变小，不能变大。
    if (
      state === "confirmed_in_scope" ||
      state === "confirmed_exempt" ||
      state === "gray_data" ||
      state === "gray_interpretive" ||
      state === "unverifiable"
    ) {
      allowed.add(state);
    }
  }
  return [...allowed];
}

/** verdict 决定的 `gray_type`（§2.1.1 一致性约束的唯一真相）。 */
function grayTypeFor(verdict: Verdict): GrayType | null {
  if (verdict === "gray_data") return "data";
  if (verdict === "gray_interpretive") return "interpretive";
  return null;
}

function normalizeFlags(flags: readonly string[]): string[] {
  const set = new Set<string>();
  for (const flag of flags) {
    const normalized = flag.trim().toLowerCase();
    if (normalized !== "") set.add(normalized);
  }
  return [...set].sort();
}

/** 截断到规定长度上限；返回是否发生过截断。 */
function clampList(list: readonly string[]): { list: string[]; clamped: boolean } {
  let clamped = false;
  const capped = list.slice(0, MAX_LIST_LENGTH);
  if (capped.length !== list.length) clamped = true;
  const out = capped.map((element) => {
    if (element.length <= MAX_LIST_ITEM_CHARS) return element;
    clamped = true;
    return element.slice(0, MAX_LIST_ITEM_CHARS);
  });
  return { list: out, clamped };
}

/**
 * 跑完 §4.4 的 8 条检查，返回修正后的 domain 结果与 repairs 清单。
 *
 * @throws {LlmSchemaError} 第 1 条 wire 形状检查失败（调用方负责重试/兜底）
 */
export function validateAdjudication(input: ValidateInput): ValidateOutput {
  // ① wire 形状
  if (!isAdjudicationWire(input.wire)) {
    throw new LlmSchemaError();
  }
  const wire: AdjudicationWire = input.wire;

  const repairs: string[] = [];
  const addedFlags: string[] = [];

  // ② item_id：不信任模型返回值，直接以请求项覆写
  let itemId = wire.item_id;
  if (itemId !== input.itemId) {
    itemId = input.itemId;
    repairs.push("item_id_overwritten");
    addedFlags.push("item_id_mismatch");
  }

  // ③ verdict 越界 → 保守降级为 unverifiable
  let verdict: Verdict = wire.verdict;
  if (!input.allowedVerdicts.includes(verdict)) {
    verdict = "unverifiable";
    repairs.push("verdict_downgraded");
    addedFlags.push("verdict_out_of_rubric_scope");
  }

  // ④ gray_type 与 verdict 一致性：**以 verdict 为准**重写
  const expectedGrayType = grayTypeFor(verdict);
  const wireGrayType: GrayType | null = wire.gray_type === "none" ? null : wire.gray_type;
  if (wireGrayType !== expectedGrayType) {
    repairs.push("gray_type_rewritten");
    addedFlags.push("gray_type_mismatch");
  }

  // ⑤ source_refs 白名单：逐字匹配，剔除越界项
  // —— 防"模型把材料里的文本当法源引用"的关键一步
  const whitelist = new Set(input.sourceWhitelist);
  const keptRefs = wire.source_refs.filter((ref) => whitelist.has(ref));
  if (keptRefs.length !== wire.source_refs.length) {
    repairs.push("source_refs_filtered");
    addedFlags.push("unlisted_source_ref");
  }

  // ⑥ 长度上限
  const clampedRefs = clampList(keptRefs);
  if (clampedRefs.clamped) {
    repairs.push("source_refs_clamped");
    addedFlags.push("output_truncated");
  }
  const clampedModelFlags = clampList(wire.risk_flags);
  if (clampedModelFlags.clamped) {
    repairs.push("risk_flags_clamped");
    addedFlags.push("output_truncated");
  }

  // ⑦ risk_flags 归一 + 与沙箱 detected_flags 取并集（确定性，模型漏报不影响结果）
  const riskFlags = normalizeFlags([
    ...clampedModelFlags.list,
    ...input.sandboxFlags,
    ...addedFlags,
  ]);

  // ⑧ confidence 防御性兜底（strict 已保证，这里只是不留死角）
  const confidence: Confidence = CONFIDENCES.includes(wire.confidence) ? wire.confidence : "low";
  if (confidence !== wire.confidence) repairs.push("confidence_defaulted");

  const normalizedWire: AdjudicationWire = {
    item_id: itemId,
    verdict,
    confidence,
    source_refs: clampedRefs.list,
    risk_flags: riskFlags,
    gray_type: expectedGrayType ?? "none",
  };

  return { result: toDomain(normalizedWire), repairs };
}

/**
 * §4.5 兜底：终局失败时由**确定性代码**写死的最保守结果。
 *
 * 不是 LLM 生成的，也**不写入 golden cache**（否则错误会被固化）。
 * `unverifiable` 是五态里最保守的一个，且 Policy Engine 的 condition 本来就
 * 不读 verdict（§1.2），所以该兜底不可能造成资金被错误放行。
 */
export type FallbackReason = "llm_refusal" | "adjudicator_unavailable" | "llm_schema_error";

export function buildFallbackResult(
  itemId: string,
  reason: FallbackReason,
  sandboxFlags: readonly string[] = [],
): AdjudicationResult {
  return {
    item_id: itemId,
    verdict: "unverifiable",
    confidence: "low",
    source_refs: [],
    risk_flags: normalizeFlags([reason, ...sandboxFlags]),
  };
}
