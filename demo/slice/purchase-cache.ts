/**
 * 采购幂等：**同一案件的同一个 Module 只买一次**（不变量 6「重试不重复付款」）。
 *
 * 为什么必须有这层：链上写操作的幂等由 `IdempotencyStore` 管住了，但 x402 采购
 * 是**链下付款**，不经过那条路径。没有这层的话，同一个案件每重跑一次就再付一次
 * 0.80 USDC——彩排三次就是 2.40。而「重试不重复付款」正是我们要在彩排里
 * **演示**给人看的性质，如果重跑真的重复付了，那条不变量就成了空话。
 *
 * 存的是**完整响应 + Gateway 回执**：回执是账本 `module_fee` / `royalty` 行的
 * `ref`（v2.3 §3.5），丢了它这两行就渲染不出来。
 *
 * 落盘位置跟随 DB 目录，这样 `db:reset` 清库时这份缓存也一并被清掉——
 * 「冷启动」必须是真的冷启动，否则彩排验证不了任何东西。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertModuleResponse } from "@citely/chain";
import type { ModuleResponse } from "@citely/chain";

/** 一次已完成的采购。 */
export interface CachedPurchase {
  readonly response: ModuleResponse;
  /** Gateway 结算 ID —— 账本 `gateway_receipt` 类目的 `ref`。 */
  readonly settlementId: string;
  /** 实付金额，最小单位十进制字符串（JSON 没有 bigint）。 */
  readonly paidAtomic: string;
  /** 采购时刻，ISO8601。仅供人读与审计，不进任何哈希。 */
  readonly purchasedAt: string;
}

/** 采购缓存文件不可用。 */
export class PurchaseCacheError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PurchaseCacheError";
  }
}

/**
 * 采购缓存的文件路径。
 *
 * @param dbPath - 引擎 SQLite 路径；缓存放它旁边，`db:reset` 一并清掉
 * @param caseId - 案件标识
 * @param moduleId - Module 标识
 * @returns 缓存文件绝对路径
 */
export function purchaseCachePath(dbPath: string, caseId: string, moduleId: string): string {
  return join(dirname(dbPath), "purchases", `${caseId}__${moduleId}.json`);
}

/**
 * 读取本案该 Module 的既有采购。
 *
 * @param path - 由 {@link purchaseCachePath} 算出的路径
 * @returns 既有采购；没有则 `null`
 * @throws {PurchaseCacheError} 文件存在但损坏——**不静默当作"没买过"**，
 *   那会导致重复付款，正是本模块要防的事
 */
export function loadPurchase(path: string): CachedPurchase | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new PurchaseCacheError(
      `purchase cache at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PurchaseCacheError(`purchase cache at ${path} must be an object`);
  }
  const rec = raw as Record<string, unknown>;
  const settlementId = rec["settlementId"];
  const paidAtomic = rec["paidAtomic"];
  const purchasedAt = rec["purchasedAt"];
  if (
    typeof settlementId !== "string" ||
    settlementId === "" ||
    typeof paidAtomic !== "string" ||
    typeof purchasedAt !== "string"
  ) {
    throw new PurchaseCacheError(`purchase cache at ${path} is missing required fields`);
  }
  // 缓存里的响应仍要过形状校验：落过盘不等于可信，文件可能被手改坏。
  return {
    response: assertModuleResponse(rec["response"]),
    settlementId,
    paidAtomic,
    purchasedAt,
  };
}

/**
 * 记下一次采购。
 *
 * @param path - 缓存文件路径
 * @param purchase - 采购内容
 */
export function savePurchase(path: string, purchase: CachedPurchase): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(purchase, null, 2)}\n`, "utf8");
}
