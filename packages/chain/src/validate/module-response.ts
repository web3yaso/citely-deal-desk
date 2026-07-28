import { isAddress } from "viem";

import { ChainError } from "../errors.js";
import type {
  CheckResult,
  CheckStatus,
  ModuleId,
  ModuleResponse,
  SettlementConstraints,
} from "../types/module.js";

/** 已上线的 Module ID 全集（msb-agent `ModuleIdSchema`）。 */
export const MODULE_IDS: readonly ModuleId[] = ["us-msb", "uk-msb", "eu-msb", "sg-msb"];

const CHECK_STATUSES: readonly CheckStatus[] = ["PASS", "HOLD", "ESCALATE"];

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

function readCheck(value: unknown, index: number): CheckResult {
  const path = `checks[${String(index)}]`;
  if (!isRecord(value)) {
    return fail(path, "不是对象");
  }
  return {
    id: readString(value, "id", path),
    result: readEnum(value, "result", CHECK_STATUSES, path),
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
    disclaimer: readString(data, "disclaimer", ""),
  };
}
