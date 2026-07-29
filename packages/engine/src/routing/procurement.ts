/**
 * 出口 3 的**采购三约束**（v2.3 §2.1b：白名单 + 单笔上限 + 余额物理上限）。
 *
 * > 采购三约束：白名单（仅允许注册过的 module 端点）、单笔上限、
 * > 预算钱包余额物理上限。付款失败 → 幂等重试 → 仍失败该腿转 HOLD。
 *
 * 三条都是**在付款之前**的确定性检查——纯函数，不发请求。
 * 真正的付款由 chain 的 `X402Client` 做，本文件只回答"这笔该不该付"。
 *
 * 关于"仍失败该腿转 HOLD"：这里**没有**为它写任何特殊代码路径，
 * 因为不需要——采购失败意味着我们仍然只有采购前的那份 Module 结果，
 * 而那份结果的 `blocked_check_ids` 非空（正是它触发了数据缺口），
 * Policy Engine 据此本来就会算出 `HOLD`。给不变量 2 开一条"运营原因改判定"的
 * 后门去实现一个它已经能做到的结果，是纯粹的风险。`procurement.test.ts`
 * 里有一条测试把这个性质钉死。
 */

import { usdc6, type Usdc6 } from "../util/usdc6.js";

/** 采购限额配置。金额一律最小单位。 */
export interface ProcurementLimits {
  /** 已注册的 module 端点白名单（逐字全等匹配，不做前缀/通配）。 */
  readonly endpointWhitelist: readonly string[];
  /** 单笔上限。 */
  readonly maxSingleSpend: Usdc6;
  /** 采购钱包在 Gateway 的可用余额——**物理上限**，超了根本付不出去。 */
  readonly gatewayAvailable: Usdc6;
  /** 本案已花费合计，用于案件级预算上限（可选，不传则不检查）。 */
  readonly spentThisCase?: Usdc6;
  /** 案件级预算上限（可选）。 */
  readonly maxPerCase?: Usdc6;
}

/** 一次采购请求。 */
export interface ProcurementRequest {
  /** 完整端点 URL，必须逐字命中白名单。 */
  readonly endpoint: string;
  /** 报价金额（402 报价单里的 `amount`）。 */
  readonly amount: Usdc6;
}

/** 拒绝原因。每一条都对应 §2.1b 的一条约束。 */
export type ProcurementDenial =
  | "not_whitelisted"
  | "exceeds_single_cap"
  | "insufficient_gateway_balance"
  | "exceeds_case_budget";

export type ProcurementVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly denial: ProcurementDenial; readonly detail: string };

/**
 * 三约束检查。**任一条不过就不许付款。**
 *
 * 检查顺序按"越便宜越先查"排：白名单是字符串比对，余额是已知数字。
 * 顺序不影响结论（四条互相独立），但影响错误信息里先报哪一条。
 *
 * @param request - 端点与报价金额
 * @param limits - 三约束配置
 * @returns 放行或带原因的拒绝
 */
export function checkProcurement(
  request: ProcurementRequest,
  limits: ProcurementLimits,
): ProcurementVerdict {
  if (!limits.endpointWhitelist.includes(request.endpoint)) {
    return {
      allowed: false,
      denial: "not_whitelisted",
      detail: `endpoint is not on the registered module whitelist: ${request.endpoint}`,
    };
  }

  if (request.amount > limits.maxSingleSpend) {
    return {
      allowed: false,
      denial: "exceeds_single_cap",
      detail: `amount ${request.amount.toString()} exceeds single-spend cap ${limits.maxSingleSpend.toString()}`,
    };
  }

  if (request.amount > limits.gatewayAvailable) {
    return {
      allowed: false,
      denial: "insufficient_gateway_balance",
      detail: `amount ${request.amount.toString()} exceeds gateway available ${limits.gatewayAvailable.toString()}`,
    };
  }

  if (limits.maxPerCase !== undefined) {
    const spent = limits.spentThisCase ?? usdc6(0n);
    if (spent + request.amount > limits.maxPerCase) {
      return {
        allowed: false,
        denial: "exceeds_case_budget",
        detail: `case spend would reach ${(spent + request.amount).toString()}, over budget ${limits.maxPerCase.toString()}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 采购结果（由调用方在真正付款之后填）。
 *
 * `settlementId` 空字符串**视为失败**（合约 §9：`payment.transaction` 是结算 ID，
 * 空串视为失败）——这是 msb-agent 实测里踩过的坑，写进类型注释免得再踩。
 */
export interface ProcurementOutcome {
  readonly ok: boolean;
  readonly settlementId: string;
  readonly attempts: number;
}

/** 判断一次采购是否真的成功（空结算 ID 不算成功）。 */
export function isProcurementSuccessful(outcome: ProcurementOutcome): boolean {
  return outcome.ok && outcome.settlementId.trim() !== "";
}

/** 幂等重试上限。付款是花钱操作，重试次数必须是个小而明确的常数。 */
export const PROCUREMENT_MAX_ATTEMPTS = 3;

/**
 * 还该不该再试一次。
 *
 * 幂等由 chain 的 `IdempotencyStore` 保证（同 key 不重发），本函数只管次数。
 */
export function shouldRetryProcurement(outcome: ProcurementOutcome): boolean {
  return !isProcurementSuccessful(outcome) && outcome.attempts < PROCUREMENT_MAX_ATTEMPTS;
}
