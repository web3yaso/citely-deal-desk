/**
 * 编排入口的数据契约：请求、注入的依赖端口、结果与结果快照。
 *
 * 设计要点：
 * - **engine 不读环境变量、不选实现**。链上写、验证器三检、收口、x402 采购、
 *   判定器 provider 全部由调用方注入——服务侧（Railway）与演示侧注入的是不同实现，
 *   而编排主线只有这一条。
 * - **不 import `@citely/verifier`**（依赖方向 `chain ← engine ← verifier`）。
 *   三检与收口的类型在这里以**结构化视图**给出，verifier 的 `VerificationReport` /
 *   `SettlementAction` 结构上就满足它们，调用方直接把函数塞进来即可。
 */

import type { DealInput, JobClient, ModuleId, X402Client } from "@citely/chain/types";
import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { AdjudicatedItem, AdjudicatorDeps } from "../adjudicator/index.js";
import type { BriefingPack } from "../escalation/briefing.js";
import type { CaseStore } from "../db/store.js";
import type { LedgerEntry } from "../ledger/types.js";
import type { LedgerStore } from "../ledger/store.js";
import type { CaseExit, ExitActor, ExitChainAction } from "../routing/exits.js";
import type { LoadedRubric } from "../rubric/types.js";
import type { SettlementAuthorization } from "../sa/types.js";
import type { Logger } from "../util/logger.js";
import type { Usdc6 } from "../util/usdc6.js";
import type { CaseRunStore } from "./run-store.js";
import type { PurchaseStore } from "./purchase-store.js";

/** 一条三检结论的结构化视图（verifier 的 `CheckOutcome` 结构上满足它）。 */
export interface CheckOutcomeView {
  readonly check: string;
  readonly passed: boolean;
  readonly failures: readonly { readonly code: string; readonly detail?: string }[];
}

/**
 * 三检报告的结构化视图（verifier 的 `VerificationReport` 结构上满足它）。
 *
 * 只取编排真正要用的三个字段：要不要收口（`passed`）、上链的理由哈希（`reasonHash`）、
 * 给人看的逐检结论。**engine 不需要知道 verifier 的内部形状。**
 */
export interface VerificationReportView {
  readonly passed: boolean;
  readonly reasonHash: Hex;
  readonly outcomes: readonly CheckOutcomeView[];
}

/** 收口动作的结构化视图（verifier 的 `SettlementAction` 结构上满足它）。 */
export interface SettlementActionView {
  readonly action: "complete" | "reject";
  readonly txHash: Hex;
}

/** {@link VerifyPort} 的入参。 */
export interface VerifyRequest {
  readonly sa: SettlementAuthorization;
  readonly rubric: LoadedRubric;
  /** 链上 `submit` 实际提交的 deliverableHash，用于强制一致。 */
  readonly submittedDeliverableHash: Hex;
  readonly chainId: number;
}

/** 三检端口。信任根（认证清单 / 注册表）由调用方持有，engine 不碰。 */
export type VerifyPort<TReport extends VerificationReportView = VerificationReportView> = (
  request: VerifyRequest,
) => Promise<TReport>;

/** {@link SettlePort} 的入参。 */
export interface SettleRequest<TReport extends VerificationReportView = VerificationReportView> {
  readonly jobId: bigint;
  readonly report: TReport;
}

/** 收口端口（`complete` / `reject`，用验证器密钥发交易）。 */
export type SettlePort<TReport extends VerificationReportView = VerificationReportView> = (
  request: SettleRequest<TReport>,
) => Promise<SettlementActionView>;

/** 出口 4（解释性 gray）产出升级材料所需的配置。 */
export interface EscalationConfig {
  /** Review Job 的委托人——专家的钱永远来自委托人（Marketplace）。 */
  readonly client: Address;
  /** 评审方。 */
  readonly provider: Address;
  readonly evaluator: Address;
  /** 评审截止时刻。**必须由调用方给定**：取墙上时钟会让 `sa_hash` 每次都变。 */
  readonly expiresAt: Date;
  /** Review 保证金。 */
  readonly deposit: Usdc6;
}

/** 8183 Job 的开案参数。 */
export interface JobRequest {
  readonly provider: Address;
  readonly evaluator: Address;
  /**
   * 链上 Job 的 `expiredAt`（Unix 秒）。
   *
   * **由调用方给定，不取墙上时钟**：它会被回读进 SA 的 `bound_to.expires_at`，
   * 而后者在 `deliverableHash` 的输入里——用 `Date.now()` 就等于每跑一次换一个
   * `sa_hash`，"同样输入 → 同样 SA"这条对外承诺当场失效。
   */
  readonly expiredAt: bigint;
  /** 案件费（escrow 预算）。 */
  readonly budgetAtomic: Usdc6;
  readonly description?: string;
  /**
   * **外部已建好并注资的 Job**（演示 UI：浏览器钱包自己当 8183 client）。
   *
   * 给定时编排跳过 createJob/setBudget/fund，只做链上校验：Job 必须已是
   * `funded`、provider/evaluator 与本请求一致、budget 与 `budgetAtomic`
   * 逐字相等——校验不过抛 {@link ExternalJobError}，绝不"将就着用"。
   *
   * 已知限制（testnet 演示范围）：**不验证请求发起者就是该 Job 的 client**。
   * 知道一个已注资 jobId 的人可以借用它提交自己的 deal；修复需要请求签名。
   */
  readonly existingJobId?: bigint;
}

/** 结算腿的商务参数（当前一案一腿；多腿是后续扩展）。 */
export interface SettlementRequest {
  /** 腿标识，进 SA 的 `legs[].party`。 */
  readonly party: string;
  /** 收款方——**不是**任何 Citely 地址（不变量 3）。 */
  readonly payee: Address;
  readonly amountAtomic: Usdc6;
}

/** 一次案件编排的完整输入。 */
export interface CaseRequest {
  /** 幂等键。客户端重发同一个 `caseId` 不会重复建 Job、重复付费、重复入账。 */
  readonly caseId: string;
  readonly deal: DealInput;
  readonly rubric: LoadedRubric;
  /** 要采购的 Module 与其报价（报价用于账本的 `amount_nominal`）。 */
  readonly module: { readonly id: ModuleId; readonly quotedPriceAtomic: Usdc6 };
  readonly job: JobRequest;
  readonly settlement: SettlementRequest;
  readonly chainId: number;
  /** 出口 4 才用得到；命中出口 4 而没给，编排会响亮失败。 */
  readonly escalation?: EscalationConfig;
}

/** engine 侧的持久化仓储集合（由调用方打开同一个连接后注入）。 */
export interface CaseStores {
  readonly cases: CaseStore;
  readonly ledger: LedgerStore;
  readonly runs: CaseRunStore;
  readonly purchases: PurchaseStore;
}

/** {@link runCase} 的依赖注入。 */
export interface RunCaseDeps<TReport extends VerificationReportView = VerificationReportView> {
  /** 已接好幂等存储与三把钥匙的链上客户端（真实实现或演示替身）。 */
  readonly jobClient: JobClient;
  readonly stores: CaseStores;
  readonly adjudicator: AdjudicatorDeps;
  /** x402 采购客户端。engine 在它外面再套一层案件级采购幂等。 */
  readonly x402: X402Client;
  /** 签 SA 的运营账户（合约 §5.1：SA 的签名者是运营密钥）。 */
  readonly operatorAccount: LocalAccount;
  readonly verify: VerifyPort<TReport>;
  readonly settle: SettlePort<TReport>;
  /** 只用于 `attestation.signed_at`（不进 `sa_hash`）与记录时间戳。 */
  readonly clock?: () => Date;
  readonly logger?: Logger;
}

/** 本次采购的回执。`reused = true` 表示命中案件级采购幂等，**这次没付钱**。 */
export interface ProcurementReceipt {
  readonly settlementId: string;
  /** 实付金额，最小单位十进制字符串（快照要能进 JSON）。 */
  readonly paidAtomic: string;
  readonly reused: boolean;
}

/** 路由结论的快照视图。 */
export interface RoutingView {
  readonly exit: CaseExit;
  readonly chainAction: ExitChainAction;
  readonly actor: ExitActor;
  readonly reason: string;
}

/**
 * 一次成功运行的**可序列化**快照，落 `case_runs`。
 *
 * 重放时原样返回，所以它必须是 JSON 安全的：金额与 jobId 都是十进制字符串，
 * 没有 bigint、没有 Date。账本行不进快照——它已经在 `ledger` 表里，
 * 重放时从库里读，避免同一份数据存两处而后对不上。
 */
export interface CaseRunSnapshot {
  readonly caseId: string;
  /** 8183 jobId 的十进制字符串。 */
  readonly jobId: string;
  readonly routing: RoutingView;
  readonly sa: SettlementAuthorization;
  readonly saHash: Hex;
  readonly adjudication: readonly AdjudicatedItem[];
  readonly verification: VerificationReportView;
  readonly settlement: SettlementActionView | null;
  readonly procurement: ProcurementReceipt | null;
  /**
   * 出口 4 的会谈卷宗**正文**（链下，不变量 4：链上只有它的哈希）。
   * 其余出口为 `null`。落盘/投递由调用方决定，engine 只负责产出。
   */
  readonly briefingPack: BriefingPack | null;
}

/** {@link runCase} 的返回值。 */
export interface CaseResult {
  readonly caseId: string;
  readonly jobId: bigint;
  readonly routing: RoutingView;
  readonly sa: SettlementAuthorization;
  readonly saHash: Hex;
  readonly adjudication: readonly AdjudicatedItem[];
  readonly verification: VerificationReportView;
  /** 链上收口动作；出口 3（等采购）等未收口的情况为 `null`。 */
  readonly settlement: SettlementActionView | null;
  readonly procurement: ProcurementReceipt | null;
  /** 出口 4 的会谈卷宗正文（链下）；其余出口为 `null`。 */
  readonly briefingPack: BriefingPack | null;
  /** 本案件在库里的全部账本行（重放时同样从库里读）。 */
  readonly ledger: readonly LedgerEntry[];
  /**
   * `true` = 命中请求级幂等，本次**一步都没重跑**（没建 Job、没付费、没入账）。
   * 服务可以据此决定 HTTP 状态码。
   */
  readonly replayed: boolean;
}
