import { setTimeout as delay } from "node:timers/promises";

import { ChainError } from "./errors.js";
import type { JobClient, JobState } from "./types/job.js";

/**
 * 轮询默认间隔（毫秒）。
 *
 * 架构不变量「轮询不订阅」：本模块只用定时拉取，
 * **禁止** `watchEvent` / `watchBlocks` / WebSocket 订阅。
 */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** 轮询默认超时（毫秒）。 */
export const DEFAULT_POLL_TIMEOUT_MS = 300_000;

export interface PollOptions {
  /** 两次拉取之间的间隔，默认 {@link DEFAULT_POLL_INTERVAL_MS}。 */
  readonly intervalMs?: number;
  /** 总超时，默认 {@link DEFAULT_POLL_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  /** 外部取消信号；中止时抛出 {@link ChainError}。 */
  readonly signal?: AbortSignal;
}

function assertNotAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted === true) {
    throw new ChainError(`${what} 已被调用方中止`);
  }
}

/**
 * 反复调用 `fetchOnce` 直到 `isDone` 成立或超时。
 *
 * 第一次拉取立即执行（不先等一个间隔），失败即抛出——重试策略由调用方决定，
 * 这里不吞任何异常。
 *
 * @param fetchOnce - 单次拉取
 * @param isDone - 终止条件
 * @param what - 出错消息里对"在等什么"的描述
 * @param options - 间隔 / 超时 / 取消
 */
export async function pollUntil<T>(
  fetchOnce: () => Promise<T>,
  isDone: (value: T) => boolean,
  what: string,
  options: PollOptions = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const { signal } = options;
  const deadline = Date.now() + timeoutMs;

  let attempts = 0;
  let last: T | undefined;
  for (;;) {
    assertNotAborted(signal, what);
    last = await fetchOnce();
    attempts += 1;
    if (isDone(last)) {
      return last;
    }
    if (Date.now() + intervalMs > deadline) {
      throw new ChainError(
        `${what} 轮询超时：${String(timeoutMs)}ms 内共拉取 ${String(attempts)} 次，` +
          `最后一次结果为 ${JSON.stringify(last)}`,
      );
    }
    try {
      await delay(intervalMs, undefined, signal === undefined ? undefined : { signal });
    } catch (error: unknown) {
      // AbortSignal 触发时 timers/promises 会 reject，转成统一的 ChainError。
      throw new ChainError(`${what} 已被调用方中止`, {}, { cause: error });
    }
  }
}

/**
 * 轮询 8183 Job 状态，直到进入 `targets` 之一。
 *
 * @param client - JobClient 实现
 * @param jobId - Job ID
 * @param targets - 期望到达的状态集合
 * @param options - 间隔 / 超时 / 取消
 * @returns 实际到达的状态
 */
export async function waitForJobState(
  client: Pick<JobClient, "getJobState">,
  jobId: bigint,
  targets: readonly JobState[],
  options: PollOptions = {},
): Promise<JobState> {
  const wanted = new Set(targets);
  return pollUntil(
    async () => client.getJobState(jobId),
    (state) => wanted.has(state),
    `job ${jobId.toString()} 等待状态 ${targets.join("|")}`,
    options,
  );
}
