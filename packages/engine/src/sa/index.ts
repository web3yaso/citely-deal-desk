/**
 * SA 核心层（合约 §5.0：归 engine，verifier `import` 本模块，不许再写一份）。
 *
 * 对外只暴露这一个入口：EIP-712 域与类型、SA 数据契约、`deliverableHash`、
 * 认证消息构造与签名、SA 组装。
 */

export {
  ARC_TESTNET_CHAIN_ID,
  CITELY_EIP712_DOMAIN_NAME,
  CITELY_EIP712_DOMAIN_VERSION,
  citelyDomain,
  MODULE_ATTESTATION_PRIMARY_TYPE,
  MODULE_ATTESTATION_TYPES,
  SA_ATTESTATION_TYPES,
  SA_PRIMARY_TYPE,
} from "./eip712.js";
export type { ModuleAttestationMessage, SaAttestationMessage } from "./eip712.js";

export { SA_CONDITIONS, SA_CONFIDENCES, SA_DISCLAIMER } from "./types.js";
export type {
  SaAttestation,
  SaBasis,
  SaBody,
  SaBoundTo,
  SaCondition,
  SaConfidence,
  SaEscalation,
  SaLeg,
  SaModuleUsed,
  SaPreview,
  SettlementAuthorization,
} from "./types.js";

export { computeDeliverableHash, saBody } from "./hash.js";

export { buildSaAttestationMessage, InvalidJobIdError, parseJobId, signSaAttestation } from "./sign.js";
export type { SignSaAttestationParams } from "./sign.js";

export {
  assertNoForbiddenWording,
  buildSaBody,
  buildSaPreview,
  buildSettlementAuthorization,
  FORBIDDEN_SA_PHRASES,
  InvalidSaExpiryError,
  SA_VERSION,
  saExpiresAt,
  SaWordingError,
} from "./build.js";
export type { BuildSaBodyParams, BuildSettlementAuthorizationParams } from "./build.js";
