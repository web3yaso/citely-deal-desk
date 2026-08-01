/**
 * `POST /cases` 的完整请求体。
 *
 * ## 为什么不是"裸 DealInput"
 *
 * engine 的 `CaseRequest` 需要三样 `DealInput` 里**没有**的东西：
 * 收款方地址、结算金额、以及案件 Job 的到期时刻。少了收款方就压根产不出 SA
 * （SA 的每条腿都要有 `payee`），所以请求体在 DealInput 之外必须再带一个
 * `settlement` 块。请求体的其余字段仍然逐字就是 DealInput。
 *
 * ## 为什么 `expires_at` 必填
 *
 * 它会被写进链上 Job、再回读进 SA 的 `bound_to.expires_at`，而后者在
 * `sa_hash` 的输入里。服务端取墙上时钟的话，同一份输入每次跑出来的 `sa_hash`
 * 都不同，"同样输入 → 同样 SA"这条对外承诺当场失效。**所以由调用方给定，
 * 服务端不替它猜。**
 */

import type { DealInput } from "@citely/chain";
import { usdc6FromDecimal, Usdc6Error } from "@citely/engine";
import type { Usdc6 } from "@citely/engine";
import type { Address } from "viem";

import { parseDealInput } from "./deal-input.js";
import type { ParseResult, ValidationIssue } from "./deal-input.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** 腿标识：进 SA 的 `legs[].party`。 */
const PARTY_PATTERN = /^[\w-]{1,64}$/;

export interface CaseSettlementRequest {
  readonly party: string;
  /** 收款方——**不是**任何 Citely 地址（不变量 3 由客户钱包自己把关）。 */
  readonly payee: Address;
  readonly amountAtomic: Usdc6;
}

export interface CaseRequestBody {
  readonly deal: DealInput;
  readonly settlement: CaseSettlementRequest;
  /** 案件 Job 的到期时刻。 */
  readonly expiresAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettlement(
  raw: unknown,
  issues: ValidationIssue[],
): CaseSettlementRequest | undefined {
  if (!isRecord(raw)) {
    issues.push({ path: "settlement", message: "Must be an object." });
    return undefined;
  }

  // 注意：**判断的是"校验是否通过"，不是"类型是不是 string"**。
  // 形状错的字符串（如 payee="0x1234"）依然是 string，只看类型会把它放行。
  const rawParty = raw["party"];
  const party =
    typeof rawParty === "string" && PARTY_PATTERN.test(rawParty) ? rawParty : undefined;
  if (party === undefined) {
    issues.push({ path: "settlement.party", message: "Must be 1-64 characters of letters, digits, underscore or hyphen." });
  }

  const rawPayee = raw["payee"];
  const payee =
    typeof rawPayee === "string" && ADDRESS_PATTERN.test(rawPayee)
      ? (rawPayee as Address)
      : undefined;
  if (payee === undefined) {
    issues.push({ path: "settlement.payee", message: "Must be a 20-byte hex address." });
  }

  const amount = raw["amount_usdc"];
  let amountAtomic: Usdc6 | undefined;
  if (typeof amount !== "string") {
    // 金额只收字符串：JSON number 是 IEEE754 双精度，"12500.10" 这类值会失真。
    issues.push({ path: "settlement.amount_usdc", message: '必须是十进制字符串（如 "12500.00"）' });
  } else {
    try {
      amountAtomic = usdc6FromDecimal(amount);
    } catch (error: unknown) {
      // 不吞错：把金额解析器给出的原因带出去，调用方才知道该怎么改。
      const reason = error instanceof Usdc6Error ? error.message : "金额格式非法";
      issues.push({ path: "settlement.amount_usdc", message: reason });
    }
  }

  if (party === undefined || payee === undefined || amountAtomic === undefined) {
    return undefined;
  }
  return { party, payee, amountAtomic };
}

function parseExpiresAt(raw: unknown, issues: ValidationIssue[]): Date | undefined {
  if (typeof raw !== "string") {
    issues.push({ path: "expires_at", message: "Required. Must be an ISO 8601 timestamp." });
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    issues.push({ path: "expires_at", message: "Not a valid ISO 8601 timestamp." });
    return undefined;
  }
  return parsed;
}

/**
 * 校验 `POST /cases` 的请求体。
 *
 * @param raw - 已解析的 JSON 请求体
 * @returns 成功时带 deal / settlement / expiresAt，失败时带逐字段 issues
 */
export function parseCaseRequest(raw: unknown): ParseResult<CaseRequestBody> {
  if (!isRecord(raw)) {
    return { ok: false, issues: [{ path: "", message: "Request body must be a JSON object." }] };
  }

  const dealResult = parseDealInput(raw);
  const issues: ValidationIssue[] = dealResult.ok ? [] : [...dealResult.issues];

  const settlement = parseSettlement(raw["settlement"], issues);
  const expiresAt = parseExpiresAt(raw["expires_at"], issues);

  if (!dealResult.ok || settlement === undefined || expiresAt === undefined) {
    return { ok: false, issues };
  }
  return { ok: true, value: { deal: dealResult.value, settlement, expiresAt } };
}
