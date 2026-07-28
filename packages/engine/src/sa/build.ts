/**
 * SA 组装（v2.2 §4.2 全文：case_id / sa_version / bound_to / modules_used /
 * legs[] / preview / attestation）。
 *
 * **措辞纪律（红线，CLAUDE.md）**：SA 是"条件证明，由钱包按自有预设策略核验执行"，
 * **绝不写 "Citely authorizes the payment"**。这条纪律不靠人记得——
 * {@link assertNoForbiddenWording} 在每次组装时扫一遍规范化字节，命中即抛错。
 */

import type { LocalAccount } from "viem/accounts";

import { buildPreview } from "../policy/legs.js";
import { canonicalJson } from "../util/canonical.js";
import { signSaAttestation } from "./sign.js";
import type {
  SaBody,
  SaLeg,
  SaModuleUsed,
  SaPreview,
  SettlementAuthorization,
} from "./types.js";

/** SA 的 schema 版本（v2.2 §4.2 示例值）。 */
export const SA_VERSION = "1";

/**
 * 禁用措辞（小写匹配）。
 *
 * 前三条是"Citely 授权付款"的各种说法——SA 不授权任何付款，它只陈述条件；
 * 后两条是常见的等价滑坡（"批准放款"/"指示钱包付款"）。
 */
export const FORBIDDEN_SA_PHRASES: readonly string[] = [
  "citely authorizes",
  "authorizes the payment",
  "authorize the payment",
  "approves the payment",
  "instructs the wallet to pay",
];

/** SA 文案命中禁用措辞。 */
export class SaWordingError extends Error {
  public readonly phrase: string;

  public constructor(phrase: string) {
    super(`SA contains forbidden wording: ${phrase}`);
    this.name = "SaWordingError";
    this.phrase = phrase;
  }
}

/**
 * 扫描 SA（或任何将随 SA 对外呈现的对象）的规范化字节，命中禁用措辞即抛错。
 *
 * @param value - 待检查的对象
 * @throws {SaWordingError} 命中 {@link FORBIDDEN_SA_PHRASES} 任一条
 */
export function assertNoForbiddenWording(value: unknown): void {
  const text = canonicalJson(value).toLowerCase();
  for (const phrase of FORBIDDEN_SA_PHRASES) {
    if (text.includes(phrase)) throw new SaWordingError(phrase);
  }
}

/** {@link buildSaBody} 的参数。 */
export interface BuildSaBodyParams {
  readonly caseId: string;
  /** 8183 jobId。bigint 或十进制字符串皆可，落盘统一为字符串（JSON 没有 bigint）。 */
  readonly jobId: bigint | string;
  /** SA 有效期。`Date` 会被规范化为 ISO8601 UTC。 */
  readonly expiresAt: Date | string;
  readonly modulesUsed: readonly SaModuleUsed[];
  readonly legs: readonly SaLeg[];
  /** 本 SA 覆盖的 rubric 判定项数（验证器第 3 检按它对账）。 */
  readonly itemsCovered: number;
  /** 覆盖默认 `preview`。不传则由 `legs` 统计生成。 */
  readonly preview?: SaPreview;
}

/**
 * 组装 SA 正文（不含 `attestation`）。
 *
 * @param params - 案件绑定信息、Module 版本、已算出 condition 的腿
 * @returns SA 正文
 * @throws {SaWordingError} 正文命中禁用措辞
 */
export function buildSaBody(params: BuildSaBodyParams): SaBody {
  const body: SaBody = {
    case_id: params.caseId,
    sa_version: SA_VERSION,
    bound_to: {
      job_id: typeof params.jobId === "bigint" ? params.jobId.toString() : params.jobId,
      expires_at:
        typeof params.expiresAt === "string" ? params.expiresAt : params.expiresAt.toISOString(),
    },
    modules_used: params.modulesUsed,
    legs: params.legs,
    preview: params.preview ?? buildPreview(params.legs, params.itemsCovered),
  };
  assertNoForbiddenWording(body);
  return body;
}

/** {@link buildSettlementAuthorization} 的参数。 */
export interface BuildSettlementAuthorizationParams extends BuildSaBodyParams {
  /** 由 `OPERATOR_PRIVATE_KEY` 派生的账户。**不是**验证器密钥（合约 §5.1）。 */
  readonly account: LocalAccount;
  readonly chainId?: number;
  readonly signedAt?: Date;
}

/**
 * 组装并签名完整 SA。
 *
 * @param params - {@link BuildSaBodyParams} 加签名账户
 * @returns 可直接交付的 SA（`attestation.signature` 由运营密钥签发）
 * @throws {SaWordingError} 正文命中禁用措辞
 */
export async function buildSettlementAuthorization(
  params: BuildSettlementAuthorizationParams,
): Promise<SettlementAuthorization> {
  const body = buildSaBody(params);
  const attestation = await signSaAttestation({
    body,
    account: params.account,
    ...(params.chainId === undefined ? {} : { chainId: params.chainId }),
    ...(params.signedAt === undefined ? {} : { signedAt: params.signedAt }),
  });
  return { ...body, attestation };
}

export { buildPreview as buildSaPreview };
