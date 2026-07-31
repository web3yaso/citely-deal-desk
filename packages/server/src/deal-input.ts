/**
 * `POST /cases` 请求体（{@link DealInput}）的手写校验。
 *
 * 仓库不引入 zod（合约 §依赖白名单），字段逐字对齐 `@citely/chain` 的
 * `types/module.ts`，与上游 msb-agent 的 `DealInputSchema` 同源。
 *
 * **不抛异常、返回 issues**：这个校验发生在**收费之前**，调用方需要拿到
 * 逐字段的原因去改请求；抛错会让 HTTP 层只能回一句笼统的 400。
 */

import type { Activity, DealInput, Party, PartyRole } from "@citely/chain";

const ACTIVITIES: readonly Activity[] = [
  "money_transmission",
  "currency_exchange",
  "stored_value",
  "crypto_transfer",
  "check_cashing",
];

const PARTY_ROLES: readonly PartyRole[] = ["payer", "payee"];

/** ISO 3166-1 alpha-2，大写两位。 */
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

/** deal_id 上限：够长可承载业务号，又不至于被塞进一段文本当注入面。 */
const MAX_DEAL_ID_LENGTH = 128;

/** 单笔交易参与方数量上限——挡住"一个请求塞一万个 party"的放大攻击。 */
const MAX_PARTIES = 32;

export interface ValidationIssue {
  /** 字段路径，如 `parties.0.country`。 */
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(prefix: string, key: string | number): string {
  return prefix === "" ? String(key) : `${prefix}.${String(key)}`;
}

function checkParty(raw: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    issues.push({ path, message: "必须是对象" });
    return;
  }
  const role = raw["role"];
  if (typeof role !== "string" || !(PARTY_ROLES as readonly string[]).includes(role)) {
    issues.push({ path: at(path, "role"), message: `必须是 ${PARTY_ROLES.join(" | ")}` });
  }
  const country = raw["country"];
  if (typeof country !== "string" || !COUNTRY_PATTERN.test(country)) {
    issues.push({ path: at(path, "country"), message: "必须是大写两位 ISO 3166-1 alpha-2" });
  }
  const state = raw["state"];
  if (state !== undefined && (typeof state !== "string" || state === "")) {
    issues.push({ path: at(path, "state"), message: "存在时必须是非空字符串" });
  }
}

function checkDealId(raw: Record<string, unknown>, issues: ValidationIssue[]): void {
  const dealId = raw["deal_id"];
  if (typeof dealId !== "string" || dealId === "") {
    issues.push({ path: "deal_id", message: "必须是非空字符串" });
    return;
  }
  if (dealId.length > MAX_DEAL_ID_LENGTH) {
    issues.push({ path: "deal_id", message: `长度不得超过 ${String(MAX_DEAL_ID_LENGTH)}` });
  }
}

function checkParties(raw: Record<string, unknown>, issues: ValidationIssue[]): void {
  const parties = raw["parties"];
  if (!Array.isArray(parties) || parties.length === 0) {
    issues.push({ path: "parties", message: "必须是非空数组" });
    return;
  }
  if (parties.length > MAX_PARTIES) {
    issues.push({ path: "parties", message: `参与方不得超过 ${String(MAX_PARTIES)} 个` });
    return;
  }
  parties.forEach((party, index) => {
    checkParty(party, at("parties", index), issues);
  });
}

function checkAmounts(raw: Record<string, unknown>, issues: ValidationIssue[]): void {
  const amount = raw["amount_usdc"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    issues.push({ path: "amount_usdc", message: "必须是大于 0 的有限数" });
  }
  const monthly = raw["monthly_volume_usdc"];
  if (
    monthly !== undefined &&
    monthly !== null &&
    (typeof monthly !== "number" || !Number.isFinite(monthly) || monthly < 0)
  ) {
    issues.push({ path: "monthly_volume_usdc", message: "存在时必须是不小于 0 的有限数或 null" });
  }
}

/**
 * 校验并返回 {@link DealInput}。
 *
 * @param raw - 已解析的 JSON 请求体
 * @returns 成功时带值，失败时带逐字段 issues（**不抛异常**）
 */
export function parseDealInput(raw: unknown): ParseResult<DealInput> {
  if (!isRecord(raw)) {
    return { ok: false, issues: [{ path: "", message: "请求体必须是 JSON 对象" }] };
  }

  const issues: ValidationIssue[] = [];
  checkDealId(raw, issues);
  checkParties(raw, issues);

  const activity = raw["activity"];
  if (typeof activity !== "string" || !(ACTIVITIES as readonly string[]).includes(activity)) {
    issues.push({ path: "activity", message: `必须是 ${ACTIVITIES.join(" | ")}` });
  }

  checkAmounts(raw, issues);

  const evidence = raw["evidence"];
  if (!isRecord(evidence)) {
    issues.push({ path: "evidence", message: "必须是对象" });
  }

  if (issues.length > 0) return { ok: false, issues };

  // 校验已逐字段通过，这里的断言有上面的检查兜底；
  // 逐字段重建而不是直接透传，避免多余字段随请求流进下游。
  const parties = (raw["parties"] as readonly Record<string, unknown>[]).map((party): Party => {
    const state = party["state"];
    return {
      role: party["role"] as PartyRole,
      country: party["country"] as string,
      ...(typeof state === "string" ? { state } : {}),
    };
  });

  const monthly = raw["monthly_volume_usdc"];
  return {
    ok: true,
    value: {
      deal_id: raw["deal_id"] as string,
      parties,
      activity: activity as Activity,
      amount_usdc: raw["amount_usdc"] as number,
      ...(monthly === undefined ? {} : { monthly_volume_usdc: monthly as number | null }),
      evidence: evidence as Record<string, unknown>,
    },
  };
}
