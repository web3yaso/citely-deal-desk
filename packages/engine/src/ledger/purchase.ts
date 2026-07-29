/**
 * x402 采购 → 账本条目的适配层。
 *
 * **这是 `ref_type: "gateway_receipt"` 那一态真正跑起来的地方**：
 * 付款那一刻链上还没有结算交易，我们手里唯一的引用就是 Gateway 结算 ID。
 *
 * 入参直接是 chain 的 `ModuleCheckResult`（不是我们自己抄一份形状）——
 * chain 改返回值，这里编译期就红。之前 chain 把 `GatewayPayResult.transaction`
 * 吞掉时，账本这一态是**拿不到 `ref` 的**，而 dry-run 走录制快照永远执行不到，
 * 测试全绿但真实路径上是空的。类型直连是防这类缺口最便宜的办法。
 */

import type { ModuleCheckResult, ModuleResponse } from "@citely/chain/types";
import type { Address } from "viem";

import { usdc6, type Usdc6 } from "../util/usdc6.js";
import { entryForModuleFee, entryForRoyalty } from "./entries.js";
import type { LedgerEntry } from "./types.js";

/** 零地址 = 无版税（并行计划 §二"版税行前提"；api.md 声明该参数不被 evidence_hash 背书）。 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** basis point 分母。与链上费率同一套约定。 */
const BPS_DENOMINATOR = 10_000n;

/** 结算 ID 为空——绝不能拿它去写账本。 */
export class MissingSettlementIdError extends Error {
  public constructor(moduleId: string) {
    super(`x402 purchase for ${moduleId} returned an empty settlementId; refusing to record a ledger row without a ref`);
    this.name = "MissingSettlementIdError";
  }
}

/**
 * 应付给 Module maintainer 的版税。
 *
 * 它是**一笔独立的支付**，有自己的 Gateway 回执，所以这里只算"该付多少、付给谁"，
 * 不产生账本行——账本行等真的付了、拿到那笔的回执之后再由
 * {@link entryForRoyalty} 记。把"义务"和"已支付"混成一行是账本最容易造假的地方。
 */
export interface RoyaltyObligation {
  readonly payee: Address;
  readonly amount: Usdc6;
  readonly bps: number;
}

/**
 * 按 Module 响应里的真值算版税。
 *
 * **`maintainer_wallet` 与 `royalty_bps` 一律从 `response` 读，不许用占位值**——
 * us-msb 的真值是 `0x76B0…47B9` / `500`(5%)，但那也不该写死在代码里：
 * 四个模块各不相同，且 maintainer 可以换钱包。
 *
 * 版税按**实付模块费的比例**计算（`paidAtomic * royalty_bps / 10000`，向下取整）。
 *
 * @param response - Module 响应
 * @param paidAtomic - 该次采购的实付金额
 * @returns 版税义务；零地址 maintainer 或 `royalty_bps = 0` 时返回 `null`（不该有这一拍）
 */
export function royaltyObligationFor(
  response: ModuleResponse,
  paidAtomic: Usdc6,
): RoyaltyObligation | null {
  const payee = response.maintainer_wallet;
  if (payee.toLowerCase() === ZERO_ADDRESS) return null;
  if (!Number.isInteger(response.royalty_bps) || response.royalty_bps <= 0) return null;

  const amount = usdc6((paidAtomic * BigInt(response.royalty_bps)) / BPS_DENOMINATOR);
  // 比例太小导致取整为 0 时，不产生一笔 0 元版税——账本上的 0 元行只会误导读者。
  if (amount === 0n) return null;
  return { payee, amount, bps: response.royalty_bps };
}

/** {@link purchaseLedgerEntries} 的返回值。 */
export interface PurchaseAccounting {
  /** 立即可入账的行（目前只有 module_fee）。 */
  readonly entries: readonly LedgerEntry[];
  /** 待支付的版税；无版税时为 `null`。 */
  readonly royalty: RoyaltyObligation | null;
}

/**
 * 把一次真实 x402 采购结果转成账本条目。
 *
 * `ref = settlementId`、`ref_type = "gateway_receipt"`、`amount_actual = paidAtomic`
 * —— v2.3 §3.5 那条契约的落地形态。
 *
 * `amount_nominal` 同样取 `paidAtomic`：402 报价单与实付在 Gateway 路径上是同一个数，
 * **不按定价表推算**（定价表会漂，实付不会）。若将来报价与实付可能不同，
 * 由调用方改用 {@link entryForModuleFee} 显式分别传入。
 *
 * @param params - 采购结果、Module ID 与案件 ID
 * @returns 可入账的行 + 版税义务
 * @throws {MissingSettlementIdError} 结算 ID 为空
 */
export function purchaseLedgerEntries(params: {
  readonly caseId: string;
  readonly moduleId: string;
  readonly result: ModuleCheckResult;
}): PurchaseAccounting {
  const settlementId = params.result.settlementId.trim();
  if (settlementId === "") throw new MissingSettlementIdError(params.moduleId);

  const paid = usdc6(params.result.paidAtomic);
  const moduleFee = entryForModuleFee({
    caseId: params.caseId,
    quoted: paid,
    paid,
    gatewayReceipt: settlementId,
  });

  return {
    entries: [moduleFee],
    royalty: royaltyObligationFor(params.result.response, paid),
  };
}

/**
 * 版税真的付掉之后，用**那笔支付自己的**回执记账。
 *
 * 刻意不复用模块采购的 `settlementId`：那是另一笔钱、另一次结算，
 * 共用一个 ref 会让对账时两笔支出叠在同一个回执上。
 */
export function royaltyLedgerEntry(params: {
  readonly caseId: string;
  readonly obligation: RoyaltyObligation;
  readonly gatewayReceipt: string;
}): LedgerEntry {
  return entryForRoyalty({
    caseId: params.caseId,
    amount: params.obligation.amount,
    gatewayReceipt: params.gatewayReceipt,
  });
}
