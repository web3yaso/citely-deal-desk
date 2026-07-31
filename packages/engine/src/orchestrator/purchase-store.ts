/**
 * 采购幂等：**同一案件的同一个 Module 只付费一次**（不变量 6「重试不重复付款」）。
 *
 * 为什么必须单独有这层：链上写操作的幂等由 `tx_log` 管住了，但 x402 采购是
 * **链下付款**，根本不经过那条路径。没有这层的话，同一个请求重发一次就再付一次
 * 0.80 USDC——而"重试不重复付款"正是我们要演示的性质。
 *
 * 存的是**完整响应 + Gateway 回执**：回执是账本 `module_fee` / `royalty` 行的
 * `ref`（v2.3 §3.5），丢了它这两行就渲染不出来。
 */

import { assertModuleResponse } from "@citely/chain";
import type { DealInput, ModuleId, ModuleResponse, X402Client } from "@citely/chain/types";

import type { EngineDatabase } from "../db/schema.js";
import { procurementOutcomeFrom } from "../routing/procurement.js";
import { usdc6, usdc6FromAtomicString, usdc6ToAtomicString } from "../util/usdc6.js";
import type { Usdc6 } from "../util/usdc6.js";

/** 一次已完成的采购。 */
export interface PurchaseRecord {
  readonly caseId: string;
  readonly moduleId: string;
  readonly response: ModuleResponse;
  /** Gateway 结算 ID —— 账本 `gateway_receipt` 类目的 `ref`。 */
  readonly settlementId: string;
  readonly paidAtomic: Usdc6;
  readonly purchasedAt: string;
}

/** 采购付款失败（结算 ID 为空即视为失败，合约 §9）。 */
export class ProcurementFailedError extends Error {
  public constructor(caseId: string, moduleId: string) {
    super(`x402 purchase for ${caseId}/${moduleId} returned an empty settlement id`);
    this.name = "ProcurementFailedError";
  }
}

/** 落盘的采购记录损坏。**不静默当作"没买过"**——那会导致重复付款。 */
export class PurchaseRecordError extends Error {
  public constructor(caseId: string, moduleId: string, detail: string) {
    super(`purchase record for ${caseId}/${moduleId} is unusable: ${detail}`);
    this.name = "PurchaseRecordError";
  }
}

interface PurchaseRow {
  readonly case_id: string;
  readonly module_id: string;
  readonly settlement_id: string;
  readonly paid_atomic: string;
  readonly response_json: string;
  readonly purchased_at: string;
}

function toRecord(row: PurchaseRow): PurchaseRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(row.response_json);
  } catch (err) {
    throw new PurchaseRecordError(row.case_id, row.module_id, `response is not valid JSON: ${(err as Error).message}`);
  }
  return {
    caseId: row.case_id,
    moduleId: row.module_id,
    // 落过盘不等于可信：库文件可能被手改坏，读回来仍过一遍形状校验。
    response: assertModuleResponse(raw),
    settlementId: row.settlement_id,
    paidAtomic: usdc6FromAtomicString(row.paid_atomic),
    purchasedAt: row.purchased_at,
  };
}

/** 采购记录仓储。 */
export class PurchaseStore {
  private readonly db: EngineDatabase;
  private readonly clock: () => Date;

  public constructor(db: EngineDatabase, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  /** 查本案该 Module 的既有采购；没有返回 `null`。 */
  public find(caseId: string, moduleId: string): PurchaseRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM purchases WHERE case_id = ? AND module_id = ?`)
      .get(caseId, moduleId) as PurchaseRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * 记下一次采购。
   *
   * 用 `INSERT OR IGNORE`：并发下两个请求即使都付了款，也只留第一条记录，
   * 而不是让第二条把第一条覆盖掉——覆盖会让账本里已入账的那个回执失去出处。
   *
   * @returns 库里最终生效的那条记录
   */
  public record(params: {
    readonly caseId: string;
    readonly moduleId: string;
    readonly response: ModuleResponse;
    readonly settlementId: string;
    readonly paidAtomic: Usdc6;
  }): PurchaseRecord {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO purchases
           (case_id, module_id, settlement_id, paid_atomic, response_json, purchased_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.caseId,
        params.moduleId,
        params.settlementId,
        usdc6ToAtomicString(params.paidAtomic),
        JSON.stringify(params.response),
        this.clock().toISOString(),
      );
    const stored = this.find(params.caseId, params.moduleId);
    if (stored === null) throw new PurchaseRecordError(params.caseId, params.moduleId, "insert vanished");
    return stored;
  }

  /** 列出本案的全部采购（按 module 排序），对账用。 */
  public list(caseId: string): readonly PurchaseRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM purchases WHERE case_id = ? ORDER BY module_id`)
      .all(caseId) as PurchaseRow[];
    return rows.map(toRecord);
  }
}

/** {@link procureOnce} 的结果。`reused = true` 表示这次**没有付钱**。 */
export interface ProcurementResult {
  readonly record: PurchaseRecord;
  readonly reused: boolean;
}

/** {@link procureOnce} 的参数。 */
export interface ProcureOnceParams {
  readonly store: PurchaseStore;
  readonly x402: X402Client;
  readonly caseId: string;
  readonly moduleId: ModuleId;
  readonly dealInput: DealInput;
}

/**
 * 幂等采购：本案该 Module 已买过就直接复用，**不再付款**。
 *
 * @param params - 仓储、x402 客户端、案件与模块
 * @returns 采购记录与"这次有没有真付钱"
 * @throws {ProcurementFailedError} 付款返回空结算 ID（视为失败，不入库、不入账）
 */
export async function procureOnce(params: ProcureOnceParams): Promise<ProcurementResult> {
  const existing = params.store.find(params.caseId, params.moduleId);
  if (existing !== null) return { record: existing, reused: true };

  const result = await params.x402.check(params.moduleId, params.dealInput);
  // 空结算 ID 在 chain 侧就该被当失败抛掉，这里复查一次：这是信任边界，
  // 空串一旦漏过来，账本里会写出一行 ref = "" 的垃圾记录。
  const outcome = procurementOutcomeFrom(result);
  if (!outcome.ok) throw new ProcurementFailedError(params.caseId, params.moduleId);

  const record = params.store.record({
    caseId: params.caseId,
    moduleId: params.moduleId,
    response: result.response,
    settlementId: outcome.settlementId,
    paidAtomic: usdc6(result.paidAtomic),
  });
  return { record, reused: false };
}
