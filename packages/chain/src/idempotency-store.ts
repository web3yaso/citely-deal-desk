import { ChainError } from "./errors.js";
import type { IdempotencyRecord, IdempotencyStore } from "./types/idempotency.js";

/**
 * 内存版幂等存储。**仅供测试与 spike 脚本**——端到端时由 engine 注入 SQLite 实现，
 * 进程重启后内存版什么都记不住，绝不能用在真实流程里。
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  async lookup(key: string): Promise<IdempotencyRecord | null> {
    return this.#records.get(key) ?? null;
  }

  async record(rec: IdempotencyRecord): Promise<void> {
    const existing = this.#records.get(rec.key);
    if (existing !== undefined) {
      // 静默覆盖会把「同一动作发了两次交易」这件事抹掉，正是幂等要防的东西。
      throw new ChainError(
        `幂等键重复写入：${rec.key} 已记录 txHash=${existing.txHash}`,
        { idempotencyKey: rec.key, txHash: rec.txHash },
      );
    }
    this.#records.set(rec.key, rec);
  }

  /** 已记录的条数，测试断言用。 */
  get size(): number {
    return this.#records.size;
  }
}
