/**
 * 检查①：deliverable 哈希由 Citely 注册密钥 EIP-712 签名验签通过（合约 §6.1）。
 *
 * 四道断言，缺一不可：
 * 1. SA 正文重算出的哈希 === `attestation.sa_hash`（签的是这份 SA，不是别份）；
 * 2. 若给了链上 `submit` 的 deliverableHash，必须与之一致（链上链下同一份交付物）；
 * 3. EIP-712 签名验签到 `attestation.signer`；
 * 4. `attestation.signer` 在注册签名者名单内（信任根，不接受任意自签）。
 */

import { verifyTypedData } from "viem";
import type { Address, Hex } from "viem";

import { citelyDomain, SA_ATTESTATION_TYPES, SA_PRIMARY_TYPE } from "../eip712.js";
import { computeDeliverableHash } from "../sa/hash.js";
import { buildSaAttestationMessage, InvalidJobIdError } from "../sa/sign.js";
import type { SettlementAuthorization } from "../sa/types.js";
import { outcome } from "./types.js";
import type { CheckFailure, CheckOutcome } from "./types.js";

/** {@link checkDeliverableSignature} 的参数。 */
export interface SignatureCheckInput {
  readonly sa: SettlementAuthorization;
  /** 信任根：Citely 注册签名者地址（大小写不敏感比较）。 */
  readonly registeredSigners: readonly Address[];
  /** 链上 `submit(jobId, deliverableHash)` 实际提交的哈希。给了就必须一致。 */
  readonly submittedDeliverableHash?: Hex;
  readonly chainId?: number;
}

/** 地址与十六进制哈希都做大小写不敏感比较。 */
function eqCaseless(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 执行检查①。
 *
 * @param input - SA、注册签名者名单、可选的链上哈希与 chainId
 * @returns 检查结果；结构损坏（如 job_id 非法）也表达为不通过而非抛错
 */
export async function checkDeliverableSignature(
  input: SignatureCheckInput,
): Promise<CheckOutcome> {
  const { sa, registeredSigners, submittedDeliverableHash, chainId } = input;
  const failures: CheckFailure[] = [];

  const recomputed = computeDeliverableHash(sa);
  if (!eqCaseless(recomputed, sa.attestation.sa_hash)) {
    failures.push({
      code: "sa_hash_mismatch",
      detail: `recomputed ${recomputed} != attestation.sa_hash ${sa.attestation.sa_hash}`,
    });
  }
  if (submittedDeliverableHash !== undefined && !eqCaseless(recomputed, submittedDeliverableHash)) {
    failures.push({
      code: "onchain_hash_mismatch",
      detail: `recomputed ${recomputed} != submitted ${submittedDeliverableHash}`,
    });
  }

  if (!registeredSigners.some((addr) => eqCaseless(addr, sa.attestation.signer))) {
    failures.push({ code: "signer_not_registered", detail: sa.attestation.signer });
  }

  try {
    const valid = await verifyTypedData({
      address: sa.attestation.signer,
      domain: citelyDomain(chainId),
      types: SA_ATTESTATION_TYPES,
      primaryType: SA_PRIMARY_TYPE,
      message: buildSaAttestationMessage(sa),
      signature: sa.attestation.signature,
    });
    if (!valid) failures.push({ code: "signature_invalid" });
  } catch (err) {
    if (err instanceof InvalidJobIdError) {
      failures.push({ code: "job_id_malformed", detail: err.message });
    } else {
      // 签名字节畸形会让 viem 抛错——这是"不通过"，不是验证器故障。
      failures.push({ code: "signature_unverifiable", detail: (err as Error).name });
    }
  }

  return outcome("deliverable_signature", failures);
}
