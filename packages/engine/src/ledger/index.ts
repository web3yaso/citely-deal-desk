/**
 * 账本模块（v2.2 §3.5 / 合约 §7）。P&L 页由 {@link LedgerStore.list} 直接渲染。
 */

export { entriesForComplete, entryFor, entryForModuleFee, entryForRefund } from "./entries.js";
export type {
  CompleteEntriesParams,
  GenericEntryParams,
  ModuleFeeEntryParams,
  RefundEntryParams,
} from "./entries.js";

export { DuplicateLedgerEntryError, LedgerStore } from "./store.js";

export { LEDGER_CATEGORIES } from "./types.js";
export type { LedgerAccount, LedgerCategory, LedgerDirection, LedgerEntry } from "./types.js";
