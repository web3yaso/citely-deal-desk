import { isAddress } from "viem";

import { ChainError } from "../errors.js";
import type {
  CheckBasis,
  CheckResult,
  CheckStatus,
  ModuleId,
  ModuleResponse,
  SettlementConstraints,
} from "../types/module.js";

/** 已上线的 Module ID 全集（msb-agent `ModuleIdSchema`）。 */
export const MODULE_IDS = [
  "us-msb",
  "uk-msb",
  "eu-msb",
  "sg-msb",
  "ae-msb",
] as const satisfies readonly ModuleId[];

/**
 * 编译期穷尽性闸门：`ModuleId` 里任何一个成员没进 {@link MODULE_IDS} 就编译不过。
 *
 * 不是装饰——白名单漏一个成员的后果是"付了钱的合法响应被判非法"，
 * 而这种漏配没有任何运行时信号，只有付费之后才炸。
 * 上面那行 `satisfies readonly ModuleId[]` 只保证"名单里的每个值都是合法 id"，
 * **不保证反过来**（少写一个成员它一声不吭）；这里补的正是反方向。
 *
 * 写成"带 `extends never` 约束的默认类型参数"而不是普通类型别名：普通别名求值成
 * `never` 也不会报错，那样的检查是假的。漏成员时这里会直接报
 * `Type '"…-msb"' does not satisfy the constraint 'never'`。
 * 导出是为了它是个**被使用的符号**（否则 lint 判它未使用），零运行时形态。
 */
export type ModuleIdsAreExhaustive<
  Missing extends never = Exclude<ModuleId, (typeof MODULE_IDS)[number]>,
> = Missing;

/**
 * 运行时判定一个字符串是不是已上线的 Module ID。
 *
 * 给**环境变量 / 外部输入**用：这些值会被拼进 `POST /modules/:id/check` 的 URL，
 * 而那是一个会真的花钱的端点。`assertModuleResponse` 校验的是响应，
 * 这个函数校验的是**请求发出前**的那个字符串。
 *
 * @param value - 待判定的字符串（不做 trim，前后空格一律视为非法）
 * @returns 是否为合法 Module ID
 */
export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}

// NOT_APPLICABLE 是 2026-07-31 上游拆分出来的第四态，不是 PASS 的同义词，见 CheckStatus 注释。
const CHECK_STATUSES: readonly CheckStatus[] = ["PASS", "HOLD", "ESCALATE", "NOT_APPLICABLE"];

const CHECK_BASES: readonly CheckBasis[] = [
  "not_applicable",
  "caller_assertion",
  "missing_evidence",
  "deterministic_threshold",
  "insufficient_aggregate_data",
  "manual_review",
];

/** 64 位小写十六进制，无 `0x` 前缀。 */
const EVIDENCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

function fail(path: string, why: string): never {
  // 付过费才拿到的响应，形状不对必须炸——不能让半个响应流进 Policy Engine。
  throw new ChainError(`Module 响应字段 ${path} ${why}`);
}

/** 拼字段路径；顶层字段没有前缀，别拼出 ".module" 这种误导性路径。 */
function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    return fail(at(path, key), "缺失或不是非空字符串");
  }
  return value;
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T {
  const value = readString(obj, key, path);
  if (!(allowed as readonly string[]).includes(value)) {
    return fail(at(path, key), `取值非法：${value}（应为 ${allowed.join("|")}）`);
  }
  return value as T;
}

function readEvidenceHash(obj: Record<string, unknown>, path: string): string {
  const value = readString(obj, "evidence_hash", path);
  if (!EVIDENCE_HASH_PATTERN.test(value)) {
    return fail(at(path, "evidence_hash"), "不是 64 位小写十六进制（无 0x 前缀）");
  }
  return value;
}

function readStringArray(obj: Record<string, unknown>, key: string, path: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return fail(at(path, key), "不是字符串数组");
  }
  return value as string[];
}

function readNonNegativeInteger(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail(at(path, key), "不是非负整数");
  }
  return value;
}

function readCheck(value: unknown, index: number): CheckResult {
  const path = `checks[${String(index)}]`;
  if (!isRecord(value)) {
    return fail(path, "不是对象");
  }
  return {
    id: readString(value, "id", path),
    result: readEnum(value, "result", CHECK_STATUSES, path),
    basis: readEnum(value, "basis", CHECK_BASES, path),
    reason: readString(value, "reason", path),
    source: readString(value, "source", path),
  };
}

function readConstraints(value: unknown): SettlementConstraints {
  const path = "settlement_constraints";
  if (!isRecord(value)) {
    return fail(path, "不是对象");
  }
  return {
    module: readEnum(value, "module", MODULE_IDS, path),
    module_version: readString(value, "module_version", path),
    deal_id: readString(value, "deal_id", path),
    valid_until: readString(value, "valid_until", path),
    blocked_check_ids: readStringArray(value, "blocked_check_ids", path),
    escalated_check_ids: readStringArray(value, "escalated_check_ids", path),
    // 放行判据依赖它，缺了就必须炸：默认成 0 会误拦、默认成 checks.length 会误放。
    evaluated_check_count: readNonNegativeInteger(value, "evaluated_check_count", path),
    evidence_hash: readEvidenceHash(value, path),
  };
}

function readRoyaltyBps(obj: Record<string, unknown>): number {
  const value = obj["royalty_bps"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    return fail("royalty_bps", "不是 0–10000 的整数");
  }
  return value;
}

function readMaintainerWallet(obj: Record<string, unknown>): `0x${string}` {
  const value = readString(obj, "maintainer_wallet", "");
  if (!isAddress(value, { strict: false })) {
    return fail("maintainer_wallet", "不是合法 EVM 地址");
  }
  return value;
}

/**
 * 校验并收窄 `POST /modules/:id/check` 的 200 响应。
 *
 * 本包不引入 zod（依赖白名单），因此手写 type guard；形状不对一律抛
 * {@link ChainError} 并点名字段，绝不返回半截数据。
 *
 * @param data - `gw.pay` 返回的 `data`
 * @returns 收窄后的 {@link ModuleResponse}
 */
export function assertModuleResponse(data: unknown): ModuleResponse {
  if (!isRecord(data)) {
    return fail("(root)", "不是对象");
  }
  const checks = data["checks"];
  if (!Array.isArray(checks) || checks.length === 0) {
    return fail("checks", "缺失或为空数组");
  }
  return {
    module: readEnum(data, "module", MODULE_IDS, ""),
    version: readString(data, "version", ""),
    updated_at: readString(data, "updated_at", ""),
    maintainer_wallet: readMaintainerWallet(data),
    royalty_bps: readRoyaltyBps(data),
    checks: checks.map(readCheck),
    overall: readEnum(data, "overall", CHECK_STATUSES, ""),
    settlement_constraints: readConstraints(data["settlement_constraints"]),
    evidence_hash: readEvidenceHash(data, ""),
    engine_version: readString(data, "engine_version", ""),
    // 旧存档的 evidence_hash 不能用新引擎复现，留痕要按 scheme 分桶，所以必须读到。
    hash_scheme_version: readString(data, "hash_scheme_version", ""),
    disclaimer: readString(data, "disclaimer", ""),
  };
}
