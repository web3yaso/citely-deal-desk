/**
 * rubric 加载与校验（手写 type guard，不引入 zod/ajv——理由见
 * `docs/design/llm-provider-openai.md` §2.5）。
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import type { LoadedRubric, Rubric, RubricItem, RubricVerdictState } from "./types.js";

export type { LoadedRubric, Rubric, RubricAuthor, RubricItem, RubricVerdictState } from "./types.js";

const RUBRIC_VERDICT_STATES: readonly RubricVerdictState[] = [
  "confirmed_in_scope",
  "confirmed_exempt",
  "gray_interpretive",
];

/** rubric 文件不符合 v2.2 §4.1 schema。 */
export class RubricSchemaError extends Error {
  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "RubricSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    throw new RubricSchemaError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): readonly string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new RubricSchemaError(`${path}.${key} must be an array of strings`);
  }
  return value as readonly string[];
}

function parseItem(raw: unknown, index: number): RubricItem {
  const path = `items[${String(index)}]`;
  if (!isRecord(raw)) throw new RubricSchemaError(`${path} must be an object`);
  return {
    id: requireString(raw, "id", path),
    question: requireString(raw, "question", path),
    signals: requireStringArray(raw, "signals", path),
    acceptance_criteria: requireStringArray(raw, "acceptance_criteria", path),
    common_rejection_reasons: requireStringArray(raw, "common_rejection_reasons", path),
    source: requireString(raw, "source", path),
    confidence_rule: requireString(raw, "confidence_rule", path),
  };
}

/**
 * 校验并归一一个 rubric 对象。
 *
 * @throws {RubricSchemaError} 结构不符合 v2.2 §4.1
 */
export function parseRubric(raw: unknown): Rubric {
  if (!isRecord(raw)) throw new RubricSchemaError("rubric must be an object");

  const author = raw["author"];
  if (!isRecord(author)) throw new RubricSchemaError("rubric.author must be an object");

  const royaltyBps = raw["royalty_bps"];
  if (typeof royaltyBps !== "number" || !Number.isInteger(royaltyBps) || royaltyBps < 0) {
    throw new RubricSchemaError("rubric.royalty_bps must be a non-negative integer");
  }

  const items = raw["items"];
  if (!Array.isArray(items) || items.length === 0) {
    throw new RubricSchemaError("rubric.items must be a non-empty array");
  }

  const verdictStates = requireStringArray(raw, "verdict_states", "rubric");
  for (const state of verdictStates) {
    if (!RUBRIC_VERDICT_STATES.includes(state as RubricVerdictState)) {
      throw new RubricSchemaError(`rubric.verdict_states contains unknown state: ${state}`);
    }
  }

  const parsedItems = items.map(parseItem);
  const seen = new Set<string>();
  for (const item of parsedItems) {
    if (seen.has(item.id)) throw new RubricSchemaError(`duplicate rubric item id: ${item.id}`);
    seen.add(item.id);
  }

  return {
    scenario: requireString(raw, "scenario", "rubric"),
    version: requireString(raw, "version", "rubric"),
    last_verified_date: requireString(raw, "last_verified_date", "rubric"),
    author: {
      name: requireString(author, "name", "rubric.author"),
      license: requireString(author, "license", "rubric.author"),
      wallet: requireString(author, "wallet", "rubric.author"),
    },
    royalty_bps: royaltyBps,
    items: parsedItems,
    verdict_states: verdictStates as readonly RubricVerdictState[],
  };
}

/**
 * 从磁盘加载 rubric。`id` 取文件名（不含扩展名）——v2.2 §4.1 的 schema 里没有
 * `id` 字段，而 cache key 需要一个稳定的 rubric 标识，故由文件名派生。
 */
export function loadRubric(filePath: string): LoadedRubric {
  const text = readFileSync(filePath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RubricSchemaError(`rubric is not valid JSON: ${filePath}`, { cause: err });
  }
  return { id: basename(filePath, extname(filePath)), rubric: parseRubric(raw) };
}

/**
 * 解析一个 rubric item 的 `source` 字段为法源白名单。
 *
 * 分隔符是**两侧带空白的斜杠**（` / `），照 v2.2 §4.1 示例
 * `"31 CFR § 1010.100(ff) / FinCEN Ruling FIN-…"`。不使用裸 `/` 分割，
 * 因为法条编号本身可能含斜杠（如 `1005.30(f)/(g)`）。
 */
export function parseSourceWhitelist(source: string): readonly string[] {
  return source
    .split(/\s+\/\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
