import { describe, expect, it } from "vitest";

import { ChainError } from "./errors.js";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";

const REC = {
  key: "42:fund",
  txHash: `0x${"1".repeat(64)}`,
  submittedAt: "2026-07-28T00:00:00.000Z",
} as const;

describe("InMemoryIdempotencyStore", () => {
  it("未记录时返回 null", async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.lookup("42:fund")).resolves.toBeNull();
  });

  it("写入后能按键取回", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.record(REC);
    await expect(store.lookup("42:fund")).resolves.toEqual(REC);
    expect(store.size).toBe(1);
  });

  it("同键重复写入报错而非静默覆盖", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.record(REC);
    await expect(store.record({ ...REC, txHash: `0x${"2".repeat(64)}` })).rejects.toThrow(
      ChainError,
    );
    expect(store.size).toBe(1);
  });

  it("不同键互不影响", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.record(REC);
    await store.record({ ...REC, key: "42:submit" });
    expect(store.size).toBe(2);
  });
});
