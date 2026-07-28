import type { Address } from "viem";

/**
 * L1 module-server（外部仓库 msb-agent）的线上响应/请求形状。
 *
 * 字段与 msb-agent `src/schemas/module-response.ts`、`deal-input.ts` 逐字一致；
 * 本包不引入 zod，形状校验用手写 type guard（见 `src/validate/`）。
 */

/** 已上线的 Module ID（msb-agent `ModuleIdSchema`）。 */
export type ModuleId = "us-msb" | "uk-msb" | "eu-msb" | "sg-msb";

/** 单项检查/整体结论的三态（msb-agent `CheckStatusSchema`）。 */
export type CheckStatus = "PASS" | "HOLD" | "ESCALATE";

/** 业务活动类型（msb-agent `ActivitySchema`）。 */
export type Activity =
  | "money_transmission"
  | "currency_exchange"
  | "stored_value"
  | "crypto_transfer"
  | "check_cashing";

/** 交易参与方角色（msb-agent `PartyRoleSchema`）。 */
export type PartyRole = "payer" | "payee";

export interface CheckResult {
  readonly id: string;
  readonly result: CheckStatus;
  readonly reason: string;
  readonly source: string;
}

export interface SettlementConstraints {
  readonly module: ModuleId;
  /** `YYYY.MM.N` */
  readonly module_version: string;
  readonly deal_id: string;
  /** ISO8601 UTC，无时区偏移 */
  readonly valid_until: string;
  readonly blocked_check_ids: readonly string[];
  readonly escalated_check_ids: readonly string[];
  /** 64 位小写十六进制，无 `0x` 前缀 */
  readonly evidence_hash: string;
}

export interface ModuleResponse {
  readonly module: ModuleId;
  /** `YYYY.MM.N` */
  readonly version: string;
  /** ISO8601 UTC，无时区偏移 */
  readonly updated_at: string;
  readonly maintainer_wallet: Address;
  /** 0–10000 整数 */
  readonly royalty_bps: number;
  readonly checks: readonly CheckResult[];
  readonly overall: CheckStatus;
  readonly settlement_constraints: SettlementConstraints;
  /** 64 位小写十六进制，无 `0x` 前缀 */
  readonly evidence_hash: string;
  readonly disclaimer: string;
}

export interface Party {
  readonly role: PartyRole;
  /** ISO 3166-1 alpha-2 大写 */
  readonly country: string;
  readonly state?: string;
}

/** `POST /modules/:id/check` 的请求体（msb-agent `DealInputSchema`）。 */
export interface DealInput {
  readonly deal_id: string;
  readonly parties: readonly Party[];
  readonly activity: Activity;
  readonly amount_usdc: number;
  readonly monthly_volume_usdc?: number | null;
  readonly evidence: Readonly<Record<string, unknown>>;
}
