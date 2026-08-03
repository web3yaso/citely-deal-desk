import type { Address } from "viem";

/**
 * L1 module-server（外部仓库 msb-agent）的线上响应/请求形状。
 *
 * 字段与 msb-agent `src/schemas/module-response.ts`、`deal-input.ts` 逐字一致；
 * 本包不引入 zod，形状校验用手写 type guard（见 `src/validate/`）。
 */

/**
 * 已上线的 Module ID（msb-agent `ModuleIdSchema`）。5 个法域，`ae-msb` 于 2026-08 上线。
 *
 * 运行时白名单在 `validate/module-response.ts` 的 `MODULE_IDS`，
 * 那里有编译期穷尽性检查盯着两者一致——本类型加成员，白名单漏加就编译不过。
 */
export type ModuleId = "us-msb" | "uk-msb" | "eu-msb" | "sg-msb" | "ae-msb";

/**
 * 单项检查/整体结论的四态（msb-agent `CheckStatusSchema`）。
 *
 * - `PASS`：适用的检查项通过
 * - `HOLD`：检查项缺少必要证据
 * - `ESCALATE`：检查项无法确定性判定，需人工
 * - `NOT_APPLICABLE`：**本模块规则集对这笔交易没有可适用的检查项**
 *
 * ⚠️ `NOT_APPLICABLE` **不是 `PASS` 的同义词，更不是放行信号**。
 * 上游 2026-07-31 起把「规则未触发」从 `PASS` 里拆了出来：以前 `PASS` 同时
 * 表示"规则未触发 / 调用方提交了材料 / 数值未达门槛"三种情况，下游无法区分
 * "这条规则不适用"和"这条规则通过了"。把 `NOT_APPLICABLE` 当通过读，等于把
 * 一笔**根本没被检查过**的交易放行——`activity` 是调用方可控字段，填一个不匹配
 * 的活动类型就能让全部规则不适用、两个阻断列表都为空。放行判据请改看
 * {@link SettlementConstraints.evaluated_check_count}。
 *
 * 聚合优先级：`ESCALATE > HOLD > PASS > NOT_APPLICABLE`；仅当全部检查项都不适用时，
 * `overall` 才是 `NOT_APPLICABLE`。
 */
export type CheckStatus = "PASS" | "HOLD" | "ESCALATE" | "NOT_APPLICABLE";

/**
 * 单条 check 的判定依据（msb-agent `CheckBasisSchema`，2026-07-31 新增）。
 *
 * - `not_applicable`：规则条件未触发，或已知完整数值低于适用门槛
 * - `caller_assertion`：**调用方自述、未经独立核验**——上游没有连接任何外部注册或
 *   许可数据库，非空材料只能标记为调用方声明；据此判定的"通过"可信度低于确定性判定
 * - `missing_evidence`：缺少必要证据
 * - `deterministic_threshold`：按确定性门槛判定
 * - `insufficient_aggregate_data`：聚合数据不足以判定
 * - `manual_review`：需人工复核
 */
export type CheckBasis =
  | "not_applicable"
  | "caller_assertion"
  | "missing_evidence"
  | "deterministic_threshold"
  | "insufficient_aggregate_data"
  | "manual_review";

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
  /** 判定依据；`caller_assertion` 表示该结论只基于调用方自述。 */
  readonly basis: CheckBasis;
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
  /**
   * 非 `NOT_APPLICABLE` 的 check 数量，即本模块**实际评估过**的检查项数（≥ 0 整数）。
   *
   * 放行判据必须带上这一条：`=== 0` 表示这笔交易根本没被任何规则评估过，
   * 此时两个阻断列表天然为空、`evidence_hash` 也完全真实可复算，
   * 只看阻断列表会直接放款。`0` 应视为"需改用其他法域模块或转人工"。
   */
  readonly evaluated_check_count: number;
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
  /** 上游引擎语义版本，当前 `"1.0.0"` */
  readonly engine_version: string;
  /**
   * `evidence_hash` 预映射方案版本，当前 `"2"`。
   *
   * scheme 2 起前像里带上了版本上下文、`checks` 段从 `{id,result}` 扩为
   * `{id,result,basis}`，**旧存档的 evidence_hash 无法用新引擎复现**——
   * 录制快照与账本留痕请按本字段分桶，不要跨 scheme 比对哈希。
   */
  readonly hash_scheme_version: string;
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
