/**
 * 按 key 串行化的进程内互斥锁。
 *
 * 为什么需要它：HTTP 服务会**并发**调 `runCase`，而"同一个 caseId 的两个请求
 * 几乎同时到达"正是重试/重发的典型形态。SQLite 的 `case_runs` 行能挡住
 * **先后**到达的重复请求，但挡不住两个请求在同一个事件循环里交错——
 * 它们会一起读到"没有记录"，一起插入、一起建 Job。
 *
 * 所以请求级幂等是两件东西的组合：
 * - 进程内：本互斥锁把同 key 的调用排成队，后到者拿到锁时已经能看到前者的结果；
 * - 跨进程/跨重启：`case_runs` 表。
 *
 * 不同 key 之间完全不阻塞——服务同时处理多个案件是正常工况，不能被锁串成单线程。
 */

/** 一把按 key 分桶的互斥锁。 */
export class KeyedMutex {
  /** key → 该 key 上最后一个排队者的完成信号。没有条目 = 当前空闲。 */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * 在该 key 的临界区内执行 `fn`。
   *
   * 同 key 的调用按进入顺序串行；不同 key 并行。`fn` 抛错不会污染队列——
   * 后面排队的调用照常拿到锁（错误原样抛给它自己的调用方）。
   *
   * @param key - 串行化的粒度，编排里用 `caseId`
   * @param fn - 临界区内要跑的异步操作
   * @returns `fn` 的返回值
   */
  public async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // 只有"完成"这一个事件需要传递，错误在各自的 await 处理，所以这里吞掉
    // 前一个任务的 rejection（它已经被它自己的调用方接住了）。
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      // 队尾就是自己 = 没有后来者，删掉条目避免 Map 无限增长（服务是长跑进程）。
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }

  /** 当前有排队记录的 key 数。仅用于测试与诊断。 */
  public get size(): number {
    return this.tails.size;
  }
}
