/**
 * 三检编排（合约 §6）。
 *
 * 三检**全部执行**再汇总，不短路：出口 1 的 reject 需要完整的失败画像，
 * 只报第一条会让运营反复试错。
 */

import type { Hex } from "viem";

import { checkModuleAttestations } from "./checks/attestation.js";
import type { AttestationManifest } from "./checks/attestation.js";
import { checkRubricCoverage } from "./checks/coverage.js";
import type { RubricRef } from "./checks/coverage.js";
import { checkDeliverableSignature } from "./checks/signature.js";
import type { CheckOutcome } from "./checks/types.js";
import { buildReason, reasonHash } from "./reason.js";
import type { VerificationReason } from "./reason.js";
import { computeDeliverableHash } from "./sa/hash.js";
import type { SettlementAuthorization } from "./sa/types.js";
import type { TrustRegistry } from "./trust-registry.js";

/** {@link verifySettlementAuthorization} 的参数。 */
export interface VerificationInput {
  readonly sa: SettlementAuthorization;
  readonly rubric: RubricRef;
  readonly manifest: AttestationManifest;
  readonly registry: TrustRegistry;
  /** 链上 `submit` 实际提交的 deliverableHash（有则强制一致）。 */
  readonly submittedDeliverableHash?: Hex;
  readonly chainId?: number;
}

/** 三检的完整结论。`reasonHash` 是唯一会上链的东西。 */
export interface VerificationReport {
  readonly passed: boolean;
  readonly outcomes: readonly CheckOutcome[];
  readonly saHash: Hex;
  readonly reason: VerificationReason;
  readonly reasonHash: Hex;
}

/**
 * 跑完三检并产出上链理由哈希。
 *
 * @param input - SA、rubric、认证清单与信任注册表
 * @returns 三检结论与 `reasonHash`
 */
export async function verifySettlementAuthorization(
  input: VerificationInput,
): Promise<VerificationReport> {
  const { sa, rubric, manifest, registry, chainId } = input;

  const signatureOutcome = await checkDeliverableSignature({
    sa,
    registeredSigners: registry.citelySigners,
    ...(input.submittedDeliverableHash === undefined
      ? {}
      : { submittedDeliverableHash: input.submittedDeliverableHash }),
    ...(chainId === undefined ? {} : { chainId }),
  });
  const attestationOutcome = await checkModuleAttestations({
    sa,
    manifest,
    trustedAttesters: registry.moduleAttesters,
    ...(chainId === undefined ? {} : { chainId }),
  });
  const coverageOutcome = checkRubricCoverage({ sa, rubric });

  const outcomes = [signatureOutcome, attestationOutcome, coverageOutcome];
  const saHash = computeDeliverableHash(sa);
  const reason = buildReason({ saHash, jobId: sa.bound_to.job_id, outcomes });

  return {
    passed: outcomes.every((o) => o.passed),
    outcomes,
    saHash,
    reason,
    reasonHash: reasonHash(reason),
  };
}
