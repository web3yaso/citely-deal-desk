/**
 * Citely 的 EIP-712 域与类型定义（合约 §5 / §6①②）。
 *
 * **归属（合约 §5.0）**：依赖方向是线性的 `chain ← engine ← verifier`，
 * 所以 SA 核心层（domain/types/哈希/签名）归 **engine**；verifier `import` 本文件，
 * **不许再写一份**。签名与验签共用同一份代码，集成点靠共享代码保证一致，
 * 不靠两边各写一遍再祈祷对齐。
 *
 * 任何字段增删都必须先改 `docs/design/contracts-vertical-slice.md` 再由主导广播。
 */

import type { Hex, TypedDataDomain } from "viem";

/** EIP-712 domain 的 `name`。 */
export const CITELY_EIP712_DOMAIN_NAME = "CitelyDealDesk";

/** EIP-712 domain 的 `version`。schema 破坏性变更时递增。 */
export const CITELY_EIP712_DOMAIN_VERSION = "1";

/** Arc Testnet chainId（合约 §8 实测事实）。 */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/**
 * 构造 Citely 的 EIP-712 domain。
 *
 * 刻意**不含 `verifyingContract`**：SA 认证不被任何合约消费（链上只存
 * `deliverableHash`），没有可绑定的合约地址；跨案重放由 `jobId` 挡住，
 * 跨链重放由 `chainId` 挡住。
 *
 * @param chainId - 链 ID，默认 Arc Testnet
 * @returns 供 viem `signTypedData` / `verifyTypedData` 使用的 domain
 */
export function citelyDomain(chainId: number = ARC_TESTNET_CHAIN_ID): TypedDataDomain {
  return {
    name: CITELY_EIP712_DOMAIN_NAME,
    version: CITELY_EIP712_DOMAIN_VERSION,
    chainId,
  };
}

/** SA 认证的 primaryType。 */
export const SA_PRIMARY_TYPE = "SettlementAuthorization";

/**
 * SA 认证的类型定义。
 *
 * 签的是 SA 的**绑定信息 + 正文哈希**，不是 SA 正文——不变量 4（链上只有哈希）
 * 的延伸：认证本身也不携带业务内容。
 */
export const SA_ATTESTATION_TYPES = {
  SettlementAuthorization: [
    { name: "caseId", type: "string" },
    { name: "saVersion", type: "string" },
    { name: "jobId", type: "uint256" },
    { name: "expiresAt", type: "string" },
    { name: "deliverableHash", type: "bytes32" },
  ],
} as const;

/** {@link SA_ATTESTATION_TYPES} 对应的消息体。 */
export interface SaAttestationMessage {
  readonly caseId: string;
  readonly saVersion: string;
  readonly jobId: bigint;
  readonly expiresAt: string;
  readonly deliverableHash: Hex;
}

/** Module 版本认证的 primaryType。 */
export const MODULE_ATTESTATION_PRIMARY_TYPE = "ModuleAttestation";

/**
 * Module 版本认证的类型定义（合约 §6②）。
 * 由**演示认证密钥**离线签，与运营密钥、验证器密钥三方物理分离。
 */
export const MODULE_ATTESTATION_TYPES = {
  ModuleAttestation: [
    { name: "moduleId", type: "string" },
    { name: "version", type: "string" },
    { name: "rulesHash", type: "bytes32" },
  ],
} as const;

/** {@link MODULE_ATTESTATION_TYPES} 对应的消息体。 */
export interface ModuleAttestationMessage {
  readonly moduleId: string;
  readonly version: string;
  readonly rulesHash: Hex;
}
