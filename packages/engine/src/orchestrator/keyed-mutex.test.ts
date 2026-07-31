import { describe, expect, it } from "vitest";

import { KeyedMutex } from "./keyed-mutex.js";

/** 让出事件循环若干次，制造真实的交错机会。 */
async function yieldTicks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("KeyedMutex", () => {
  it("同 key 串行：临界区不会交错", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const task = (name: string) =>
      mutex.runExclusive("case-1", async () => {
        events.push(`${name}:enter`);
        await yieldTicks();
        events.push(`${name}:exit`);
      });

    await Promise.all([task("a"), task("b")]);

    expect(events).toEqual(["a:enter", "a:exit", "b:enter", "b:exit"]);
  });

  it("不同 key 并行：互不阻塞", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const task = (key: string, name: string) =>
      mutex.runExclusive(key, async () => {
        events.push(`${name}:enter`);
        await yieldTicks();
        events.push(`${name}:exit`);
      });

    await Promise.all([task("case-1", "a"), task("case-2", "b")]);

    // 两个 key 的临界区交错说明没有被串成单线程。
    expect(events).toEqual(["a:enter", "b:enter", "a:exit", "b:exit"]);
  });

  it("临界区抛错不会卡住后续调用", async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive("case-1", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    await expect(mutex.runExclusive("case-1", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("跑完即释放条目，长跑进程不会无限增长", async () => {
    const mutex = new KeyedMutex();
    await mutex.runExclusive("case-1", () => Promise.resolve());
    await mutex.runExclusive("case-2", () => Promise.resolve());
    expect(mutex.size).toBe(0);
  });

  it("返回临界区的返回值", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive("k", () => Promise.resolve(42))).resolves.toBe(42);
  });
});
