/**
 * 账本条目构造 —— **按净额对账**（合约 §2.4）。
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
 * 本文件里没有任何数字常量，`splitFees` 也是直接用 chain 的实现，
 * 免得两边各算一遍除法再对不上。
 */

import { splitFees } from "@citely/chain";
import type { JobFeeRates } from "@citely/chain/types";

import type { LedgerCategory, LedgerDirection, LedgerEntry } from "./types.js";

/** {@link entriesForComplete} 的参数。 */
export interface CompleteEntriesParams {
  readonly caseId: string;
  readonly jobId: bigint;
  readonly txHash: string;
  /** `job.budget`，6 位小数原子单位。 */
  readonly budget: bigint;
  /** 链上读到的费率（`JobClient.getFeeRates()`）。 */
  readonly fees: JobFeeRates;
}

/**
 * `complete` 成功后的账本条目：**两笔进账**。
 *
 * 1. 运营钱包（provider）收 `net`：`amount_nominal = budget`、`amount_actual = net`；
 * 2. 验证器钱包（evaluator）收 `evalFee`：合约 §2.4 明确要求它也入账。
 *
 * `platformFee` 去的是 8183 平台金库，不是我方钱包，**不入账**——
 * 它体现为第 1 笔里 `amount_nominal - amount_actual` 的那部分差额。
 *
 * @param params - 案件、Job、交易哈希、预算与链上费率
 * @returns 两条 `case_fee` 进账
 */
export function entriesForComplete(params: CompleteEntriesParams): readonly LedgerEntry[] {
  const { net, evaluatorFee } = splitFees(params.budget, params.fees);
  return [
    {
      direction: "in",
      amount_nominal: params.budget,
      amount_actual: net,
      jobId: params.jobId,
      txHash: params.txHash,
      category: "case_fee",
      account: "operator",
      caseId: params.caseId,
    },
    {
      direction: "in",
      amount_nominal: evaluatorFee,
      amount_actual: evaluatorFee,
      jobId: params.jobId,
      txHash: params.txHash,
      category: "case_fee",
      account: "verifier",
      caseId: params.caseId,
    },
  ];
}

/** {@link entryForRefund} 的参数。 */
export interface RefundEntryParams {
  readonly caseId: string;
  readonly jobId: bigint;
  readonly txHash: string;
  /** 名义案件费（`job.budget`）。 */
  readonly budget: bigint;
  /** 链上实际退回 client 的金额（`Refunded` 事件金额）。 */
  readonly refunded: bigint;
}

/**
 * escrow 退款（验证器 `reject` 或超时 `claimRefund`）的对账条目。
 *
 * 方向是 `out`：资金从 escrow 回到 client，我方本案零收入。
 * `claimRefund` 路径链上**不扣费**，因此 `refunded` 通常等于 `budget`；
 * 两者不等时差额一定来自链上，账本如实记录，不做任何平账。
 */
export function entryForRefund(params: RefundEntryParams): LedgerEntry {
  return {
    direction: "out",
    amount_nominal: params.budget,
    amount_actual: params.refunded,
    jobId: params.jobId,
    txHash: params.txHash,
    category: "refund",
    account: "escrow",
    caseId: params.caseId,
  };
}

/** {@link entryForModuleFee} 的参数。 */
export interface ModuleFeeEntryParams {
  readonly caseId: string;
  /** x402 报价单金额（原子单位）。 */
  readonly quoted: bigint;
  /** 实付金额；facilitator 结算后与报价一致，不一致即如实记录。 */
  readonly paid: bigint;
  /** x402 结算 ID（`payment.transaction`）。空字符串视为失败，不该走到这里。 */
  readonly settlementId: string;
  /** 采购发生在案件 Job 之外，故默认无 jobId。 */
  readonly jobId?: bigint;
}

/** x402 采购支出（采购钱包，v2.2 §2.1b）。 */
export function entryForModuleFee(params: ModuleFeeEntryParams): LedgerEntry {
  return {
    direction: "out",
    amount_nominal: params.quoted,
    amount_actual: params.paid,
    jobId: params.jobId ?? null,
    txHash: params.settlementId,
    category: "module_fee",
    account: "procurement",
    caseId: params.caseId,
  };
}

/** {@link entryFor} 的参数：其余 category 的通用构造。 */
export interface GenericEntryParams {
  readonly caseId: string | null;
  readonly jobId?: bigint;
  readonly txHash: string;
  readonly category: LedgerCategory;
  readonly direction: LedgerDirection;
  readonly amountNominal: bigint;
  readonly amountActual: bigint;
  readonly account: LedgerEntry["account"];
}

/** 通用条目构造（`kyb_data` / `royalty` / `reserve_release`）。 */
export function entryFor(params: GenericEntryParams): LedgerEntry {
  return {
    direction: params.direction,
    amount_nominal: params.amountNominal,
    amount_actual: params.amountActual,
    jobId: params.jobId ?? null,
    txHash: params.txHash,
    category: params.category,
    account: params.account,
    caseId: params.caseId,
  };
}
