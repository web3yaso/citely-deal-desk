/**
 * golden cache（`docs/design/llm-provider-openai.md` §3.5 / §4.3）。
 *
 * 它是本项目**唯一**的确定性承诺来源（L1）：相同输入 → 相同 key → 命中 →
 * 字节级相同输出。对外口径是"可复现性由 golden cache 提供，不是由模型提供"。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Canonical } from "../util/hash.js";
import type { LlmCallMeta, LlmFingerprint } from "./llm/types.js";

// 模式定义在 `modes.ts`（`llm/factory.ts` 要用它判断"这个模式要不要联网"，
// 而 `llm/*` 不许 import cache）。这里只转出去，**不许再写一份定义**。
export { ADJUDICATOR_MODES, type AdjudicatorMode } from "./modes.js";

/**
 * cache key 的构成（§4.3，字段集合一字不差）。
 *
 * **不进键的东西（进了就是 bug）**：`caseId`、时间戳、SDK 版本、`request_id`、
 * 材料原文明文、任何随机数——这样"同样的案件事实"才能跨 case / 跨天 / 跨机器
 * 命中同一条 golden。
 */
export interface CacheKeyParts {
  /** 缓存布局本身的版本，改布局时 +1。 */
  readonly cache_schema_version: 1;
  readonly prompt_version: string;
  readonly prompt_template_sha256: string;
  readonly output_schema_sha256: string;
  readonly rubric_id: string;
  readonly rubric_version: string;
  readonly rubric_item_id: string;
  readonly rubric_item_sha256: string;
  readonly facts_sha256: string;
  /**
   * 沙箱 flag 的哈希。**必须进键**：注入用例与其干净对照版的 `fields`
   * 可能几乎一致，若不进键两个测试会串缓存，注入回归就是假的（§4.3）。
   */
  readonly sandbox_flags_sha256: string;
  readonly llm: LlmFingerprint;
}

export interface GoldenEntry {
  readonly cache_key: string;
  /** 明文键材料，便于人工 diff 审阅。默认只含哈希。 */
  readonly key_inputs: Readonly<Record<string, unknown>>;
  /** LLM 原样 wire JSON（未经后置校验）。 */
  readonly wire: unknown;
  readonly meta: LlmCallMeta;
  readonly recorded_at: string;
}

export interface GoldenCache {
  computeKey(parts: CacheKeyParts): string;
  get(key: string): GoldenEntry | null;
  put(entry: GoldenEntry): void;
  readonly dir: string;
}

/** key 计算是纯函数，两种实现共用。 */
export function computeCacheKey(parts: CacheKeyParts): string {
  return sha256Canonical(parts);
}

function isGoldenEntry(value: unknown): value is GoldenEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["cache_key"] === "string" &&
    typeof obj["recorded_at"] === "string" &&
    typeof obj["meta"] === "object" &&
    obj["meta"] !== null &&
    typeof obj["key_inputs"] === "object" &&
    obj["key_inputs"] !== null
  );
}

/** 文件名/目录名安全化：模型 ID 理论上可含斜杠。 */
function safeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

export interface FileGoldenCacheOptions {
  /** 基目录，默认 `demo/golden/adjudication`。 */
  readonly dir: string;
  readonly provider: string;
  readonly model: string;
}

/**
 * 落盘实现，目录布局 `<dir>/<provider>/<model>/<cache_key>.json`。
 *
 * 同步 IO：与 better-sqlite3 的同步风格一致，且判定器本来就是逐条串行调用。
 * golden 文件永远是本地文件，**不上链**，与不变量 4 无冲突。
 */
export class FileGoldenCache implements GoldenCache {
  public readonly dir: string;
  private readonly shardDir: string;

  public constructor(options: FileGoldenCacheOptions) {
    this.dir = options.dir;
    this.shardDir = join(options.dir, safeSegment(options.provider), safeSegment(options.model));
  }

  public computeKey(parts: CacheKeyParts): string {
    return computeCacheKey(parts);
  }

  public get(key: string): GoldenEntry | null {
    const file = join(this.shardDir, `${safeSegment(key)}.json`);
    if (!existsSync(file)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // 解析失败一律按未命中：服务会**并发**判定多个案件，读到一个正在被写的
      // 半截文件是可能的（写侧已改成原子 rename，但外部工具、断电、手改都还在）。
      // 这里抛出去会让一个本可以重录的案件直接中止，代价与收益不成比例。
      return null;
    }
    if (!isGoldenEntry(raw)) {
      // 损坏的 golden 视为未命中比视为命中安全：调用方会按模式决定是重录还是失败。
      return null;
    }
    return raw;
  }

  public put(entry: GoldenEntry): void {
    mkdirSync(this.shardDir, { recursive: true });
    const file = join(this.shardDir, `${safeSegment(entry.cache_key)}.json`);
    // 先写临时文件再 rename：同目录 rename 在 POSIX 上是原子的，读者要么看到
    // 旧内容、要么看到新内容，**不会看到半截 JSON**。直接 writeFileSync 在
    // 并发（HTTP 服务同时跑多个案件）下会让读者撞上写到一半的文件。
    // 临时名带 pid + 随机数，两个进程同时录同一个 key 也不会互相覆盖临时文件。
    const tmp = `${file}.${String(process.pid)}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  }
}

/** 内存实现，单测与 `live` 模式用。 */
export class InMemoryGoldenCache implements GoldenCache {
  public readonly dir = "<memory>";
  private readonly entries = new Map<string, GoldenEntry>();

  public computeKey(parts: CacheKeyParts): string {
    return computeCacheKey(parts);
  }

  public get(key: string): GoldenEntry | null {
    return this.entries.get(key) ?? null;
  }

  public put(entry: GoldenEntry): void {
    this.entries.set(entry.cache_key, entry);
  }

  public get size(): number {
    return this.entries.size;
  }
}
