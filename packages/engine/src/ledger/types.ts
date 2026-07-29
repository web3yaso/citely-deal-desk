/**
 * 账本记录（**v2.3 §3.5 契约**）。
 *
 * 合约字段逐字：`{direction, amount_nominal, amount_actual, ref, ref_type, category}`。
 *
 * ⚠️ **v2.3 破坏性变更**：原先的 `{jobId, txHash}` 两字段已被 `{ref, ref_type}` 取代。
 * 原因是 Gateway 把大量支付授权打包成单笔链上结算、agent 每笔零 gas，
 * 于是 **module_fee 发生的那一刻只有回执、没有 txHash**——旧 schema 强行要 txHash，
 * 只能填空值或假值，而账本里的假值比缺值危险得多。
 *
 * 两个**额外的记账列**（不是 v2.3 §3.5 字段，但缺了就没法记账）：
 * - `account`：一次 `complete` 会同时给运营（`net`）和验证器（`evalFee`）各产生一笔进账
 *   （合约 §2.4），两行的 `ref`/`category`/`direction` 完全相同，没有它既区分不开
 *   也做不了"重试不重复记账"的幂等键；
 * - `settlement_tx`：§3.5 明确要求"批量结算真的发生后再补挂结算 tx（同一行可同时有
 *   回执与结算 tx）"——所以必须留这个位，且它可为空。
 */

import type { Usdc6 } from "../util/usdc6.js";

/** 资金方向（相对我方账面）。 */
export type LedgerDirection = "in" | "out";

/** 合约 §3.5 的 category 全集，不许扩充。 */
export type LedgerCategory =
  | "case_fee"
  | "module_fee"
  | "kyb_data"
  | "royalty"
  | "reserve_release"
  | "refund";

export const LEDGER_CATEGORIES: readonly LedgerCategory[] = [
  "case_fee",
  "module_fee",
  "kyb_data",
  "royalty",
  "reserve_release",
  "refund",
];

/**
 * 引用类型三态（v2.3 §3.5）。
 *
 * | `ref_type` | `ref` 的内容 | 用在哪 |
 * |---|---|---|
 * | `jobId` | 8183 Job ID | `case_fee`、`reserve_release` |
 * | `gateway_receipt` | Gateway 支付回执 ID | `module_fee`、`royalty`（x402 是链下授权，批量结算前没有 txHash） |
 * | `txHash` | 链上交易哈希 | 普通 USDC 转账、`refund` |
 */
export type LedgerRefType = "jobId" | "gateway_receipt" | "txHash";

export const LEDGER_REF_TYPES: readonly LedgerRefType[] = ["jobId", "gateway_receipt", "txHash"];

/**
 * v2.3 §3.5 明确点名的 category → ref_type 映射。
 *
 * `kyb_data` **不在表里**（§3.5 只点了另外五个），所以它不做强制——
 * 走 x402 采购时是 `gateway_receipt`，走普通转账时是 `txHash`，由调用方按实际链路给。
 * 这里如实留空，而不是替文档做一个它没做的决定。
 */
const REQUIRED_REF_TYPE: Partial<Record<LedgerCategory, LedgerRefType>> = {
  case_fee: "jobId",
  reserve_release: "jobId",
  module_fee: "gateway_receipt",
  royalty: "gateway_receipt",
  refund: "txHash",
};

/** 账本行的 `ref_type` 与 §3.5 表格不符。 */
export class LedgerRefTypeError extends Error {
  public constructor(category: LedgerCategory, actual: LedgerRefType, expected: LedgerRefType) {
    super(`ledger category ${category} requires ref_type=${expected}, got ${actual} (v2.3 §3.5)`);
    this.name = "LedgerRefTypeError";
  }
}

/**
 * 校验 `ref_type` 是否符合 §3.5 的表格。
 *
 * @throws {LedgerRefTypeError} 被点名的 category 用错了 ref_type
 */
export function assertRefTypeForCategory(
  category: LedgerCategory,
  refType: LedgerRefType,
): void {
  const expected = REQUIRED_REF_TYPE[category];
  if (expected !== undefined && expected !== refType) {
    throw new LedgerRefTypeError(category, refType, expected);
  }
}

/**
 * 记账主体。
 *
 * `escrow` 不是 Citely 钱包——8183 escrow 退款时资金从 escrow 回到 client，
 * 全程不经我方地址（不变量 3）。这一行存在的唯一理由是**对账**：
 * 终验要求"链上 `Refunded`/`PaymentReleased` 事件金额与账本 `amount_actual` 对得上"。
 */
export type LedgerAccount = "operator" | "verifier" | "procurement" | "escrow";

/** 一条账本记录。金额一律 {@link Usdc6}（6 位小数最小单位）。 */
export interface LedgerEntry {
  readonly direction: LedgerDirection;
  /** 名义金额（如 `job.budget`）。 */
  readonly amount_nominal: Usdc6;
  /** 实收/实付金额（如扣完两道手续费后的 `net`）。 */
  readonly amount_actual: Usdc6;
  /** 引用值，含义由 {@link ref_type} 决定。 */
  readonly ref: string;
  readonly ref_type: LedgerRefType;
  readonly category: LedgerCategory;
  readonly account: LedgerAccount;
  /** 关联案件，便于 P&L 页按案件汇总。 */
  readonly caseId: string | null;
  /**
   * 批量结算后补挂的链上结算交易哈希（`gateway_receipt` 行专用）。
   * 结算尚未发生时为 `null`——**空值是诚实的，假 txHash 不是**。
   */
  readonly settlement_tx: string | null;
}
