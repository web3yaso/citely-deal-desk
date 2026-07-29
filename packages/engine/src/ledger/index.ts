/**
 * 账本模块（v2.2 §3.5 / 合约 §7）。P&L 页由 {@link LedgerStore.list} 直接渲染。
 */

export {
  entriesForComplete,
  entryFor,
  entryForModuleFee,
  entryForRefund,
  entryForRoyalty,
} from "./entries.js";
export type {
  CompleteEntriesParams,
  GenericEntryParams,
  ModuleFeeEntryParams,
  RefundEntryParams,
  RoyaltyEntryParams,
} from "./entries.js";

export { DuplicateLedgerEntryError, LedgerStore, SettlementAttachError } from "./store.js";

export {
  assertRefTypeForCategory,
  LEDGER_CATEGORIES,
  LEDGER_REF_TYPES,
  LedgerRefTypeError,
} from "./types.js";
export type {
  LedgerAccount,
  LedgerCategory,
  LedgerDirection,
  LedgerEntry,
  LedgerRefType,
} from "./types.js";
