/**
 * Settlement Authorization 的数据契约（v2.2 §4.2 / 合约 §5）。
 *
 * **措辞纪律（红线）**：SA 是"条件证明，由钱包按自有预设策略核验执行"，
 * 不是 Citely 授权付款。类型名与字段名不得出现 authorize/approve 语义的动词；
 * 任何对外文案不得出现 "Citely authorizes the payment"（见 `build.ts` 的措辞单测）。
 *
 * **归属（合约 §5.0）**：本文件在 engine，verifier `import` 它，不许再写一份。
 */

import type { Address, Hex } from "viem";

import type { ReviewJobTemplate } from "../escalation/review-job.js";

/** 每腿的条件（合约 §5，与 Module 的 `CheckStatus` 同域但语义是"腿"不是"检查项"）。 */
export type SaCondition = "PASS" | "HOLD" | "ESCALATE";

/** 每腿的置信度（v2.2 §4.2，与判定器的 `confidence` 是两个不同的量）。 */
export type SaConfidence = "high" | "gray_data_resolved" | "gray_interpretive";

/** SA 允许的 condition 全集，检查③按它校验。 */
export const SA_CONDITIONS: readonly SaCondition[] = ["PASS", "HOLD", "ESCALATE"];

/** SA 允许的 confidence 全集。 */
export const SA_CONFIDENCES: readonly SaConfidence[] = [
  "high",
  "gray_data_resolved",
  "gray_interpretive",
];

/** SA 的链上绑定：只绑 Job 与有效期，不含业务内容。 */
export interface SaBoundTo {
  /** 8183 jobId 的十进制字符串（JSON 里没有 bigint）。 */
  readonly job_id: string;
  /** ISO8601 UTC。 */
  readonly expires_at: string;
}

/** SA 引用的 Module 版本，检查②按它查认证清单。 */
export interface SaModuleUsed {
  readonly module_id: string;
  /** `YYYY.MM.N` */
  readonly version: string;
  /** `0x` + 64 位十六进制。 */
  readonly evidence_hash: Hex;
}

/** 一条判定依据，指向 rubric 的判定项。 */
export interface SaBasis {
  readonly item_id: string;
  readonly verdict: string;
  readonly source: string;
}

/**
 * 解释性 gray 的升级材料（v2.3 §2.2 出口 4）。
 *
 * `review_job_template` 的**实际内容**见 `escalation/review-job.ts` 的
 * {@link ReviewJobTemplate}——`client` 恒为 Marketplace（专家的钱永远来自委托人）。
 * `briefing_pack_hash` 是会谈卷宗正文的哈希，**正文链下**（不变量 4）。
 */
export interface SaEscalation {
  readonly review_job_template: ReviewJobTemplate;
  /** `0x` + 64 位十六进制，卷宗正文的规范化字节哈希。 */
  readonly briefing_pack_hash: Hex;
}

/** 一条结算腿。`payee` 是**收款方**地址——客户资金永不经过 Citely（不变量 3）。 */
export interface SaLeg {
  readonly party: string;
  readonly payee: Address;
  /** 6 位小数原子单位的十进制字符串。 */
  readonly amount_nominal: string;
  readonly condition: SaCondition;
  readonly basis: readonly SaBasis[];
  readonly confidence: SaConfidence;
  readonly escalation?: SaEscalation;
}

/** 分层披露的摘要（Submitted 态 client 可见）。 */
export interface SaPreview {
  readonly condition_summary: string;
  readonly items_covered: number;
}

/**
 * SA 的 EIP-712 认证。
 *
 * **签名者是运营密钥 `OPERATOR_PRIVATE_KEY`，不是验证器密钥**（合约 §5.1）：
 * 若 SA 由验证器自己签、再由验证器自己验，检查①就是自己验自己，
 * 独立验证器与独立密钥的全部价值归零。
 *
 * NOTE：v2.2 §4.2 原文只有 `{sa_hash, signer, signed_at}`，没有 `signature`——
 * 没有签名字段则检查①无法进行。主导已在合约层补齐（合约 §5.0）。
 */
export interface SaAttestation {
  /** `deliverableHash`，即 `"0x" + sha256(canonicalJson(SA 去 attestation))`。 */
  readonly sa_hash: Hex;
  /** 运营钱包地址（`registry.json` 的 `citelySigners` 填的就是它）。 */
  readonly signer: Address;
  /** ISO8601 UTC。 */
  readonly signed_at: string;
  /** EIP-712 签名（65 字节）。 */
  readonly signature: Hex;
}

/** SA 正文：被签名与被哈希的部分，**不含** `attestation`（否则循环定义）。 */
export interface SaBody {
  readonly case_id: string;
  readonly sa_version: string;
  readonly bound_to: SaBoundTo;
  readonly modules_used: readonly SaModuleUsed[];
  readonly legs: readonly SaLeg[];
  readonly preview: SaPreview;
}

/** 完整 SA（交付物）。 */
export interface SettlementAuthorization extends SaBody {
  readonly attestation: SaAttestation;
}

/**
 * 免责声明。对外文档与 API 响应必须原样保留（CLAUDE.md 红线）。
 */
export const SA_DISCLAIMER =
  "输出为基于公开法源整理的检查项状态，不构成法律意见。" +
  "本 SA 是条件证明，由钱包按自有预设策略核验执行。";
