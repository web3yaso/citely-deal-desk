/**
 * SA 认证的签名侧（engine 用）与消息构造（verifier 验签侧共用）。
 *
 * 签名与验签**共用同一个 `buildSaAttestationMessage`**：集成点靠共享代码保证
 * 一致，不靠两边各写一遍再祈祷对齐。
 */

import type { LocalAccount } from "viem/accounts";

import { citelyDomain, SA_ATTESTATION_TYPES, SA_PRIMARY_TYPE } from "../eip712.js";
import type { SaAttestationMessage } from "../eip712.js";
import { computeDeliverableHash } from "./hash.js";
import type { SaAttestation, SaBody, SettlementAuthorization } from "./types.js";

/** `bound_to.job_id` 不是十进制整数字符串。 */
export class InvalidJobIdError extends Error {
  public constructor(jobId: string) {
    super(`bound_to.job_id must be a decimal integer string, got ${JSON.stringify(jobId)}`);
    this.name = "InvalidJobIdError";
  }
}

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * 把 `bound_to.job_id` 解析成 uint256 用的 bigint。
 *
 * @param jobId - 十进制整数字符串
 * @returns 对应的 bigint
 * @throws {InvalidJobIdError} 形状非法
 */
export function parseJobId(jobId: string): bigint {
  if (!DECIMAL_INTEGER.test(jobId)) throw new InvalidJobIdError(jobId);
  return BigInt(jobId);
}

/**
 * 构造待签/待验的 EIP-712 消息。
 *
 * @param body - SA 正文（含 attestation 也可，会自动剥离后取哈希）
 * @returns EIP-712 消息体
 * @throws {InvalidJobIdError} `bound_to.job_id` 形状非法
 */
export function buildSaAttestationMessage(
  body: SaBody | SettlementAuthorization,
): SaAttestationMessage {
  return {
    caseId: body.case_id,
    saVersion: body.sa_version,
    jobId: parseJobId(body.bound_to.job_id),
    expiresAt: body.bound_to.expires_at,
    deliverableHash: computeDeliverableHash(body),
  };
}

/** {@link signSaAttestation} 的参数。 */
export interface SignSaAttestationParams {
  readonly body: SaBody;
  /** Citely 注册签名密钥派生的账户。**不是**验证器密钥。 */
  readonly account: LocalAccount;
  readonly chainId?: number;
  /** 签署时间，默认当前时刻。注入是为了让测试可复现。 */
  readonly signedAt?: Date;
}

/**
 * 用 Citely 注册密钥对 SA 正文做 EIP-712 签名。
 *
 * @param params - SA 正文、签名账户、可选 chainId 与签署时间
 * @returns 可直接挂到 SA 上的 `attestation`
 */
export async function signSaAttestation(params: SignSaAttestationParams): Promise<SaAttestation> {
  const message = buildSaAttestationMessage(params.body);
  const signature = await params.account.signTypedData({
    domain: citelyDomain(params.chainId),
    types: SA_ATTESTATION_TYPES,
    primaryType: SA_PRIMARY_TYPE,
    message,
  });
  return {
    sa_hash: message.deliverableHash,
    signer: params.account.address,
    signed_at: (params.signedAt ?? new Date()).toISOString(),
    signature,
  };
}
