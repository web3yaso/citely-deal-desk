/**
 * 账本记录（合约 §7 / v2.2 §3.5）。
 *
 * 合约字段**逐字**：`{direction, amount_nominal, amount_actual, jobId, txHash, category}`。
 * `account` 是**额外的记账列**，不是合约字段——它必须存在，因为
 * 一次 `complete` 会同时给两个 Citely 钱包各产生一笔进账（运营收 net、验证器收 evalFee，
 * 合约 §2.4），两行的 `txHash`/`category`/`direction` 完全一样，没有 `account` 就无法区分、
 * 也无法做"同一笔链上动作只入账一次"的幂等约束。
 */

/** 资金方向（相对我方账面）。 */
export type LedgerDirection = "in" | "out";

/** 合约 §7 的 category 全集，不许扩充。 */
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
 * 记账主体。
 *
 * `escrow` 不是 Citely 钱包——8183 escrow 退款时资金从 escrow 回到 client，
 * 全程不经我方地址（不变量 3）。这一行存在的唯一理由是**对账**：
 * 终验要求"链上 `Refunded`/`PaymentReleased` 事件金额与账本 `amount_actual` 对得上"。
 */
export type LedgerAccount = "operator" | "verifier" | "procurement" | "escrow";

/** 一条账本记录。金额一律 6 位小数原子单位。 */
export interface LedgerEntry {
  readonly direction: LedgerDirection;
  /** 名义金额（如 `job.budget`）。 */
  readonly amount_nominal: bigint;
  /** 实收/实付金额（如扣完两道手续费后的 `net`）。 */
  readonly amount_actual: bigint;
  /** 8183 jobId；与链无关的支出（如 x402 采购）为 `null`。 */
  readonly jobId: bigint | null;
  readonly txHash: string;
  readonly category: LedgerCategory;
  readonly account: LedgerAccount;
  /** 关联案件，便于 P&L 页按案件汇总。 */
  readonly caseId: string | null;
}
