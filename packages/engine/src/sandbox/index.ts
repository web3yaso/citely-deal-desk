/**
 * 沙箱解析器（不变量 5 的上游落点）。
 *
 * 职责：把原始材料变成**只含 JSON 数据**的 `SanitizedFacts`，
 * 顺带做确定性的注入检测与超长截断。
 *
 * 硬纪律：
 * - **本文件不调 LLM**，全部是确定性代码；
 * - 检测在**截断之前**跑，否则把注入语句放在第 3000 个字符就能躲过检测；
 * - 日志与错误信息里不出现材料内容，只出现路径与哈希。
 */

import { CanonicalJsonError, canonicalJson } from "../util/canonical.js";
import { sha256Canonical, sha256Hex } from "../util/hash.js";
import { INJECTION_RULES } from "./rules.js";
import type { RawMaterial, SandboxDetection, SanitizedFacts } from "./types.js";

export type { RawMaterial, SandboxDetection, SanitizedFacts } from "./types.js";
export { INJECTION_RULES, type InjectionRule, type SandboxFlag } from "./rules.js";

/** 单个字符串字段允许的最大长度（码点数）。超出即截断。 */
export const MAX_STRING_CODE_POINTS = 2_000;
/** 单个数组允许的最大元素数。超出即截断。 */
export const MAX_ARRAY_LENGTH = 100;
/** 允许的最大嵌套深度。超出的子树整体替换为 `null`。 */
export const MAX_DEPTH = 8;

/** 材料不是合法 JSON 数据（含 `undefined`/函数/循环引用等）。 */
export class SandboxError extends Error {
  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "SandboxError";
  }
}

interface WalkContext {
  /** 去重用：key = `${rule}|${field}|${excerpt_sha256}`。 */
  readonly detections: Map<string, SandboxDetection>;
  readonly truncated: Set<string>;
}

function childPath(parent: string, segment: string): string {
  return parent === "" ? segment : `${parent}.${segment}`;
}

/**
 * 对一段文本跑全部注入规则，命中写入 `ctx.detections`（去重）。
 * 必须在截断前调用。
 */
function scanText(text: string, field: string, ctx: WalkContext): void {
  for (const rule of INJECTION_RULES) {
    // 每次新建正则：共享实例的 lastIndex 会在 g 模式下跨调用串味。
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      const excerpt = match[0];
      if (excerpt === "") continue;
      const detection: SandboxDetection = {
        rule: rule.id,
        field,
        excerpt_sha256: sha256Hex(excerpt),
      };
      const dedupeKey = `${detection.rule}|${detection.field}|${detection.excerpt_sha256}`;
      ctx.detections.set(dedupeKey, detection);
    }
  }
}

/** 按码点截断，避免把代理对劈成孤立代理。 */
function truncateByCodePoints(text: string, limit: number): string {
  // 快路径：UTF-16 长度不超限时码点数必然不超限。
  if (text.length <= limit) return text;
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) return text;
  return codePoints.slice(0, limit).join("");
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, path: string, depth: number, ctx: WalkContext): unknown {
  if (depth > MAX_DEPTH) {
    ctx.truncated.add(path);
    return null;
  }

  if (typeof value === "string") {
    scanText(value, path, ctx);
    const truncated = truncateByCodePoints(value, MAX_STRING_CODE_POINTS);
    if (truncated !== value) ctx.truncated.add(path);
    return truncated;
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  const obj = value as object;
  if (Array.isArray(obj)) {
    const kept = obj.length > MAX_ARRAY_LENGTH ? obj.slice(0, MAX_ARRAY_LENGTH) : obj;
    if (kept.length !== obj.length) ctx.truncated.add(path);
    return kept.map((element, index) =>
      walk(element, childPath(path, `[${String(index)}]`), depth + 1, ctx),
    );
  }

  // 前置的 canonicalJson 校验已排除非纯对象，这里是防御性分支。
  /* c8 ignore next 4 */
  if (!isPlainObject(obj)) {
    ctx.truncated.add(path);
    return null;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const keyPath = childPath(path, key);
    // 键名本身也可能承载注入语句。
    scanText(key, `${keyPath}#key`, ctx);
    out[key] = walk(obj[key], keyPath, depth + 1, ctx);
  }
  return out;
}

function compareDetections(a: SandboxDetection, b: SandboxDetection): number {
  return (
    a.field.localeCompare(b.field) ||
    a.rule.localeCompare(b.rule) ||
    a.excerpt_sha256.localeCompare(b.excerpt_sha256)
  );
}

/**
 * 把原始材料结构化为判定器可消费的 `SanitizedFacts`。
 *
 * @param raw 原始材料。`fields` 的值必须是 JSON 数据（基本类型/数组/纯对象）
 * @returns 已截断、已打标的结构化事实
 * @throws {SandboxError} `fields` 含不可规范化的值（`undefined`/函数/循环引用/非纯对象等）
 */
export function sanitizeMaterial(raw: RawMaterial): SanitizedFacts {
  let materialSha256: string;
  try {
    // 先算原文哈希：它必须基于**截断前**的材料，且顺带把非 JSON 值挡在门外。
    canonicalJson(raw.fields);
    materialSha256 = sha256Canonical(raw.fields);
  } catch (err) {
    if (err instanceof CanonicalJsonError) {
      throw new SandboxError(`material is not canonicalizable JSON: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }

  const ctx: WalkContext = { detections: new Map(), truncated: new Set() };
  const fields = walk(raw.fields, "", 0, ctx) as Record<string, unknown>;

  const detections = [...ctx.detections.values()].sort(compareDetections);
  const flags = new Set<string>();
  for (const detection of detections) {
    const rule = INJECTION_RULES.find((r) => r.id === detection.rule);
    if (rule !== undefined) flags.add(rule.flag);
  }

  return {
    fields,
    detected_flags: [...flags].sort(),
    detections,
    material_sha256: materialSha256,
    truncated_fields: [...ctx.truncated].sort(),
  };
}
