/**
 * 账本条目构造 —— **按净额对账**（合约 §2.4）+ **ref/ref_type 三态**（v2.3 §3.5）。
 *
 * `complete` 会在链上扣两道手续费：
 * ```
 * platformFee = amount * platformFeeBP / 10000;   // → platformTreasury（不是我方）
 * evalFee     = amount * evaluatorFeeBP / 10000;  // → evaluator（我方验证器钱包）
 * net         = amount - platformFee - evalFee;   // → provider（我方运营钱包）
 * ```
 * 所以 `case_fee` 的 `amount_nominal = job.budget`、`amount_actual = net`。
 *
 * **费率一律来自链上 view（`JobClient.getFeeRates()`），engine 严禁硬编码**——
 * 本文件里没有任何费率数字，`splitFees` 也直接用 chain 的实现，
 * 免得两边各算一遍除法再对不上。
 */

import { splitFees } from "@citely/chain";
import type { JobFeeRates } from "@citely/chain/types";

import { usdc6, type Usdc6 } from "../util/usdc6.js";
import { assertRefTypeForCategory } from "./types.js";
import type { LedgerCategory, LedgerDirection, LedgerEntry, LedgerRefType } from "./types.js";

/** 统一出口：每条账本行都从这里出去，`ref_type` 一律过 §3.5 校验。 */
function makeEntry(entry: LedgerEntry): LedgerEntry {
  assertRefTypeForCategory(entry.category, entry.ref_type);
  return entry;
}

/** {@link entriesForComplete} 的参数。 */
export interface CompleteEntriesParams {
  readonly caseId: string;
  readonly jobId: bigint;
  /** `job.budget`（最小单位）。 */
  readonly budget: Usdc6;
  /** 链上读到的费率（`JobClient.getFeeRates()`）。 */
  readonly fees: JobFeeRates;
}

/**
 * `complete` 成功后的账本条目：**两笔进账**，`ref_type = "jobId"`。
 *
 * 1. 运营钱包（provider）收 `net`：`amount_nominal = budget`、`amount_actual = net`；
 * 2. 验证器钱包（evaluator）收 `evalFee`：合约 §2.4 明确要求它也入账。
 *
 * `platformFee` 去的是 8183 平台金库，不是我方钱包，**不入账**——
 * 它体现为第 1 笔里 `amount_nominal - amount_actual` 的那部分差额。
 *
 * 这两行用 jobId 而不是 txHash 作 ref：案件费是 8183 escrow 的放款，
 * Job 才是它的稳定身份（v2.3 §3.5）。
 */
export function entriesForComplete(params: CompleteEntriesParams): readonly LedgerEntry[] {
  const { net, evaluatorFee } = splitFees(params.budget, params.fees);
  const ref = params.jobId.toString();
  return [
    makeEntry({
      direction: "in",
      amount_nominal: params.budget,
      amount_actual: usdc6(net),
      ref,
      ref_type: "jobId",
      category: "case_fee",
      account: "operator",
      caseId: params.caseId,
      settlement_tx: null,
    }),
    makeEntry({
      direction: "in",
      amount_nominal: usdc6(evaluatorFee),
      amount_actual: usdc6(evaluatorFee),
      ref,
      ref_type: "jobId",
      category: "case_fee",
      account: "verifier",
      caseId: params.caseId,
      settlement_tx: null,
    }),
  ];
}

/** {@link entryForRefund} 的参数。 */
export interface RefundEntryParams {
  readonly caseId: string;
  /** 链上退款交易哈希——退款是真实链上转账，**有** txHash。 */
  readonly txHash: string;
  /** 名义案件费（`job.budget`）。 */
  readonly budget: Usdc6;
  /** 链上实际退回 client 的金额（`Refunded` 事件金额）。 */
  readonly refunded: Usdc6;
}

/**
 * escrow 退款（验证器 `reject` 或超时 `claimRefund`）的对账条目，`ref_type = "txHash"`。
 *
 * 方向是 `out`：资金从 escrow 回到 client，我方本案零收入。
 * `claimRefund` 路径链上**不扣费**，因此 `refunded` 通常等于 `budget`；
 * 两者不等时差额一定来自链上，账本如实记录，不做任何平账。
 */
export function entryForRefund(params: RefundEntryParams): LedgerEntry {
  return makeEntry({
    direction: "out",
    amount_nominal: params.budget,
    amount_actual: params.refunded,
    ref: params.txHash,
    ref_type: "txHash",
    category: "refund",
    account: "escrow",
    caseId: params.caseId,
    settlement_tx: null,
  });
}

/** {@link entryForModuleFee} 的参数。 */
export interface ModuleFeeEntryParams {
  readonly caseId: string;
  /** x402 报价单金额。 */
  readonly quoted: Usdc6;
  /** 实付金额；与报价不一致时如实记录。 */
  readonly paid: Usdc6;
  /**
   * **Gateway 支付回执 ID**（chain 的 `X402Client.check` 返回里的 `payment.transaction`）。
   * 这是 x402 付款发生那一刻我们**唯一**拿得到的引用——批量结算尚未发生，没有 txHash。
   */
  readonly gatewayReceipt: string;
}

/**
 * x402 采购支出（采购钱包，v2.3 §2.1b），`ref_type = "gateway_receipt"`。
 *
 * `settlement_tx` 建成时恒为 `null`，等 Gateway 批量结算落链后由
 * `LedgerStore.attachSettlementTx()` 补挂。
 */
export function entryForModuleFee(params: ModuleFeeEntryParams): LedgerEntry {
  return makeEntry({
    direction: "out",
    amount_nominal: params.quoted,
    amount_actual: params.paid,
    ref: params.gatewayReceipt,
    ref_type: "gateway_receipt",
    category: "module_fee",
    account: "procurement",
    caseId: params.caseId,
    settlement_tx: null,
  });
}

/** {@link entryForRoyalty} 的参数。 */
export interface RoyaltyEntryParams {
  readonly caseId: string;
  readonly amount: Usdc6;
  readonly gatewayReceipt: string;
}

/**
 * 版税支出（付给 Module maintainer），`ref_type = "gateway_receipt"`。
 *
 * ⚠️ `maintainer_wallet` 为零地址 = 无版税（并行计划 §二"版税行前提"），
 * 那种情况下**根本不该产生这一行**，由调用方判断，本函数不猜。
 */
export function entryForRoyalty(params: RoyaltyEntryParams): LedgerEntry {
  return makeEntry({
    direction: "out",
    amount_nominal: params.amount,
    amount_actual: params.amount,
    ref: params.gatewayReceipt,
    ref_type: "gateway_receipt",
    category: "royalty",
    account: "procurement",
    caseId: params.caseId,
    settlement_tx: null,
  });
}

/** {@link entryFor} 的参数：其余 category 的通用构造。 */
export interface GenericEntryParams {
  readonly caseId: string | null;
  readonly ref: string;
  readonly ref_type: LedgerRefType;
  readonly category: LedgerCategory;
  readonly direction: LedgerDirection;
  readonly amountNominal: Usdc6;
  readonly amountActual: Usdc6;
  readonly account: LedgerEntry["account"];
  readonly settlementTx?: string;
}

/**
 * 通用条目构造（`kyb_data` / `reserve_release`，以及任何需要显式指定 ref 的场合）。
 * `ref_type` 仍会过 §3.5 校验。
 */
export function entryFor(params: GenericEntryParams): LedgerEntry {
  return makeEntry({
    direction: params.direction,
    amount_nominal: params.amountNominal,
    amount_actual: params.amountActual,
    ref: params.ref,
    ref_type: params.ref_type,
    category: params.category,
    account: params.account,
    caseId: params.caseId,
    settlement_tx: params.settlementTx ?? null,
  });
}
