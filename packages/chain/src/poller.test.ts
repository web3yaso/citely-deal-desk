import { describe, expect, it, vi } from "vitest";

import { ChainError } from "./errors.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  pollUntil,
  waitForJobState,
} from "./poller.js";
import type { JobState } from "./types/job.js";

describe("默认常量", () => {
  it("默认轮询间隔 5000ms（架构不变量：轮询不订阅）", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000);
  });

  it("默认超时 300000ms", () => {
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(300_000);
  });
});

describe("pollUntil", () => {
  it("首次拉取即满足条件时不等待、只拉一次", async () => {
    const fetchOnce = vi.fn(async () => "done");
    const started = Date.now();
    await expect(pollUntil(fetchOnce, (v) => v === "done", "测试", { intervalMs: 500 })).resolves.toBe(
      "done",
    );
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("条件未满足时按间隔重复拉取", async () => {
    const values = ["a", "b", "c"];
    let index = 0;
    const fetchOnce = vi.fn(async () => values[index++] ?? "c");
    const started = Date.now();

    await expect(pollUntil(fetchOnce, (v) => v === "c", "测试", { intervalMs: 30 })).resolves.toBe(
      "c",
    );

    expect(fetchOnce).toHaveBeenCalledTimes(3);
    // 三次拉取之间有两个间隔，实际耗时不应短于 2×30ms。
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("超时抛 ChainError 并带上最后一次结果", async () => {
    const fetchOnce = vi.fn(async () => "pending");
    await expect(
      pollUntil(fetchOnce, (v) => v === "done", "等待 X", { intervalMs: 20, timeoutMs: 60 }),
    ).rejects.toThrow(ChainError);
    await expect(
      pollUntil(fetchOnce, (v) => v === "done", "等待 X", { intervalMs: 20, timeoutMs: 60 }),
    ).rejects.toThrow(/等待 X 轮询超时/);
  });

  it("超时后不再继续拉取", async () => {
    const fetchOnce = vi.fn(async () => "pending");
    await expect(
      pollUntil(fetchOnce, () => false, "等待 X", { intervalMs: 20, timeoutMs: 50 }),
    ).rejects.toThrow(ChainError);
    const calls = fetchOnce.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetchOnce.mock.calls.length).toBe(calls);
  });

  it("已中止的 signal 会在第一次拉取前就抛错", async () => {
    const fetchOnce = vi.fn(async () => "pending");
    await expect(
      pollUntil(fetchOnce, () => false, "等待 X", { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/已被调用方中止/);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("轮询途中中止会抛 ChainError", async () => {
    const controller = new AbortController();
    const fetchOnce = vi.fn(async () => {
      if (fetchOnce.mock.calls.length >= 2) {
        controller.abort();
      }
      return "pending";
    });
    await expect(
      pollUntil(fetchOnce, () => false, "等待 X", {
        intervalMs: 20,
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(ChainError);
  });

  it("拉取本身抛错时直接透出、不吞不重试", async () => {
    const fetchOnce = vi.fn(async () => {
      throw new Error("rpc down");
    });
    await expect(pollUntil(fetchOnce, () => true, "等待 X", { intervalMs: 10 })).rejects.toThrow(
      "rpc down",
    );
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });
});

describe("waitForJobState", () => {
  it("到达目标状态之一即返回", async () => {
    const states: JobState[] = ["open", "funded", "submitted"];
    let index = 0;
    const getJobState = vi.fn(async () => states[index++] ?? "submitted");

    await expect(
      waitForJobState({ getJobState }, 42n, ["submitted", "rejected"], { intervalMs: 10 }),
    ).resolves.toBe("submitted");
    expect(getJobState).toHaveBeenCalledTimes(3);
    expect(getJobState).toHaveBeenCalledWith(42n);
  });

  it("超时消息里带 jobId 与期望状态", async () => {
    const getJobState = vi.fn(async (): Promise<JobState> => "open");
    await expect(
      waitForJobState({ getJobState }, 7n, ["completed"], { intervalMs: 10, timeoutMs: 30 }),
    ).rejects.toThrow(/job 7 等待状态 completed 轮询超时/);
  });
});
