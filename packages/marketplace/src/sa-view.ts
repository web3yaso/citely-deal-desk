/**
 * 钱包侧看到的 SA（Settlement Authorization）视图。
 *
 * **为什么客户侧要自己解析、而不是 import Citely 的 SA 类型**：
 * SA 是"条件证明，由钱包按自有预设策略核验执行"——核验的主体是钱包。
 * 如果钱包直接复用出具方的类型与解析代码，它就不是在独立核验，而是在
 * 替出具方转述。所以这里把 SA 当作**外部不可信 JSON**，自己收窄成
 * {@link ObservedSa}：Citely 多给的字段一律忽略，缺字段一律响亮报错。
 *
 * 这一层**不判断该不该付款**（那是 `policy.ts` 的事），只回答"这份 JSON
 * 在形状上是不是一份 SA"。
 */

import type { Address } from "viem";

/** 钱包认得的腿条件。SA 里出现别的值一律当作"看不懂 → 不执行"。 */
export type ObservedCondition = "PASS" | "HOLD" | "ESCALATE";

const OBSERVED_CONDITIONS: readonly string[] = ["PASS", "HOLD", "ESCALATE"];

/** SA 形状不符合钱包预期。message 含字段路径，不含字段值。 */
export class SaShapeError extends Error {
  public readonly path: string;

  public constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "SaShapeError";
    this.path = path;
  }
}

/** 钱包关心的一条结算腿。 */
export interface ObservedLeg {
  readonly party: string;
  /** 收款方地址。资金只会流向它——不变量 3。 */
  readonly payee: Address;
  /** 6 位小数原子单位。用 bigint，绝不用浮点表示钱。 */
  readonly amountAtomic: bigint;
  /** 原样保留的条件字符串；`null` 表示钱包不认得这个取值。 */
  readonly condition: ObservedCondition | null;
  /** 依据的 rubric 判定项数。 */
  readonly basisCount: number;
}

/** 钱包关心的 SA 子集。 */
export interface ObservedSa {
  readonly caseId: string;
  readonly jobId: bigint;
  /** ISO8601 UTC，SA 的有效期。 */
  readonly expiresAt: string;
  readonly moduleRefs: readonly string[];
  readonly legs: readonly ObservedLeg[];
  /** 出具方自称的签名者地址。是否可信由策略的信任根决定。 */
  readonly signer: Address;
}

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SaShapeError("expected object", path);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SaShapeError("expected array", path);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new SaShapeError("expected non-empty string", path);
  }
  return value;
}

function asAddress(value: unknown, path: string): Address {
  const raw = asString(value, path);
  if (!ADDRESS_SHAPE.test(raw)) throw new SaShapeError("expected 20-byte hex address", path);
  return raw as Address;
}

/** 十进制整数字符串 → bigint。JSON 里没有 bigint，钱包也绝不把钱读成 number。 */
function asAtomicAmount(value: unknown, path: string): bigint {
  const raw = asString(value, path);
  if (!DECIMAL_INTEGER.test(raw)) {
    throw new SaShapeError("expected decimal integer string (6-decimals atomic units)", path);
  }
  return BigInt(raw);
}

function parseLeg(raw: unknown, path: string): ObservedLeg {
  const rec = asRecord(raw, path);
  const condition = asString(rec["condition"], `${path}.condition`);
  return {
    party: asString(rec["party"], `${path}.party`),
    payee: asAddress(rec["payee"], `${path}.payee`),
    amountAtomic: asAtomicAmount(rec["amount_nominal"], `${path}.amount_nominal`),
    condition: OBSERVED_CONDITIONS.includes(condition) ? (condition as ObservedCondition) : null,
    basisCount: asArray(rec["basis"], `${path}.basis`).length,
  };
}

/**
 * 把一份外部 JSON 收窄成钱包的 SA 视图。
 *
 * @param raw - 已 `JSON.parse` 的值（来源不可信）
 * @returns 钱包视图
 * @throws {SaShapeError} 形状不符合预期
 */
export function observeSa(raw: unknown): ObservedSa {
  const root = asRecord(raw, "");
  const boundTo = asRecord(root["bound_to"], "bound_to");
  const attestation = asRecord(root["attestation"], "attestation");
  const jobId = asString(boundTo["job_id"], "bound_to.job_id");
  if (!DECIMAL_INTEGER.test(jobId)) {
    throw new SaShapeError("expected decimal integer string", "bound_to.job_id");
  }

  const moduleRefs = asArray(root["modules_used"], "modules_used").map((item, index) => {
    const path = `modules_used[${String(index)}]`;
    const rec = asRecord(item, path);
    return `${asString(rec["module_id"], `${path}.module_id`)}@${asString(rec["version"], `${path}.version`)}`;
  });

  const legs = asArray(root["legs"], "legs").map((item, index) =>
    parseLeg(item, `legs[${String(index)}]`),
  );

  return {
    caseId: asString(root["case_id"], "case_id"),
    jobId: BigInt(jobId),
    expiresAt: asString(boundTo["expires_at"], "bound_to.expires_at"),
    moduleRefs,
    legs,
    signer: asAddress(attestation["signer"], "attestation.signer"),
  };
}
