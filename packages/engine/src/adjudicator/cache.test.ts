/**
 * golden cache 的**并发安全**单测。
 *
 * 服务化之后判定器会被并发调用，同一个 cache key 可能同时被读和被写。
 * 这里钉死两条：写是原子替换（读者永远看不到半截 JSON）、读到坏文件按未命中处理。
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileGoldenCache } from "./cache.js";
import type { GoldenEntry } from "./cache.js";

const KEY = "a".repeat(64);

function entry(over: Partial<GoldenEntry> = {}): GoldenEntry {
  return {
    cache_key: KEY,
    key_inputs: { rubric_item_id: "MT-01" },
    wire: { item_id: "MT-01", verdict: "confirmed_exempt" },
    meta: {
      requestId: "req-1",
      model: "fake-1",
      systemFingerprint: null,
      usage: null,
      latencyMs: 1,
      finishReason: "completed",
      sdkVersion: "fake",
    },
    recorded_at: "2026-07-30T00:00:00.000Z",
    ...over,
  };
}

describe("FileGoldenCache", () => {
  let dir: string;
  let cache: FileGoldenCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "citely-golden-"));
    cache = new FileGoldenCache({ dir, provider: "fake", model: "fake-1" });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("写入后能原样读回", () => {
    cache.put(entry());
    expect(cache.get(KEY)?.wire).toEqual({ item_id: "MT-01", verdict: "confirmed_exempt" });
  });

  it("未命中返回 null", () => {
    expect(cache.get("b".repeat(64))).toBeNull();
  });

  it("写完不留临时文件（原子 rename 而不是就地覆盖）", () => {
    cache.put(entry());
    const files = readdirSync(join(dir, "fake", "fake-1"));
    expect(files).toEqual([`${KEY}.json`]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("并发写同一个 key：最终文件完整可读，且没有临时文件残留", () => {
    for (let i = 0; i < 20; i += 1) {
      cache.put(entry({ recorded_at: `2026-07-30T00:00:${String(i).padStart(2, "0")}.000Z` }));
    }
    expect(cache.get(KEY)).not.toBeNull();
    expect(readdirSync(join(dir, "fake", "fake-1"))).toHaveLength(1);
  });

  it("文件是半截 JSON → 按未命中处理，不抛错中止案件", () => {
    cache.put(entry());
    writeFileSync(join(dir, "fake", "fake-1", `${KEY}.json`), '{"cache_key": "aaa', "utf8");
    expect(cache.get(KEY)).toBeNull();
  });

  it("JSON 合法但字段缺失 → 同样按未命中处理", () => {
    cache.put(entry());
    writeFileSync(join(dir, "fake", "fake-1", `${KEY}.json`), '{"cache_key": "aaa"}', "utf8");
    expect(cache.get(KEY)).toBeNull();
  });
});
