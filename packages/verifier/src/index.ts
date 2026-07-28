/**
 * `@citely/verifier` —— 独立验证器进程（合约 §6）。
 *
 * 三检 → `reasonHash` → 链上收口：
 * ① deliverable 哈希由 Citely 注册密钥 EIP-712 签名验签通过；
 * ② 引用的 Module 版本存在有效认证；
 * ③ SA 覆盖 rubric 全部判定项且每腿 condition 合法。
 * 全过 → `complete(jobId, reasonHash)`；受理失败在 Funded/Submitted 态 `reject`。
 *
 * 进程边界：只持有 `VERIFIER_PRIVATE_KEY` 一把钥匙（见 `key-source.ts`），
 * 判定器那把 LLM 凭证一概不碰——三检是纯确定性检查，判定回路里没有 LLM。
 */

export { checkDeliverableSignature } from "./checks/signature.js";
export type { SignatureCheckInput } from "./checks/signature.js";

export {
  AttestationManifestError,
  checkModuleAttestations,
  loadAttestationManifest,
  parseAttestationManifest,
  verifyAttestationEntry,
} from "./checks/attestation.js";
export type {
  AttestationCheckInput,
  AttestationManifest,
  ModuleAttestationEntry,
} from "./checks/attestation.js";

export {
  AttestationSourceError,
  computeRulesHash,
  MANIFEST_VERSION,
  parseAttestationSource,
  resolveRulesHash,
  signAttestationEntry,
  signAttestationSource,
} from "./attestation-source.js";
export type { AttestationSource, AttestationSourceEntry } from "./attestation-source.js";

export { checkRubricCoverage } from "./checks/coverage.js";
export type { CoverageCheckInput, RubricRef } from "./checks/coverage.js";

export { outcome } from "./checks/types.js";
export type { CheckFailure, CheckId, CheckOutcome } from "./checks/types.js";

export { verifySettlementAuthorization } from "./verify.js";
export type { VerificationInput, VerificationReport } from "./verify.js";

export {
  COMPLETE_ALLOWED_STATES,
  EVALUATOR_REJECT_ALLOWED_STATES,
  settleVerifiedJob,
  SettlementStateError,
} from "./settle.js";
export type { SettleParams, SettlementAction } from "./settle.js";

export { buildReason, REASON_VERSION, reasonHash } from "./reason.js";
export type { ReasonCheck, VerificationReason } from "./reason.js";

export { loadTrustRegistry, parseTrustRegistry, TrustRegistryError } from "./trust-registry.js";
export type { TrustRegistry } from "./trust-registry.js";

export {
  ATTESTATIONS_DIR,
  MODULE_MANIFEST_PATH,
  MODULE_SOURCE_EXAMPLE_PATH,
  MODULE_SOURCE_PATH,
  PACKAGE_ROOT,
  TRUST_REGISTRY_EXAMPLE_PATH,
  TRUST_REGISTRY_PATH,
} from "./paths.js";

export {
  readVerifierKey,
  VERIFIER_PRIVATE_KEY_VAR,
  VerifierKeyError,
  FORBIDDEN_ENV_VARS,
} from "./key-source.js";
export type { EnvSource, VerifierKeyMaterial } from "./key-source.js";

export { redactSecrets, safeErrorMessage } from "./redact.js";

export { asAddress, asArray, asHex, asHex32, asRecord, asString, ParseError } from "./parse.js";
