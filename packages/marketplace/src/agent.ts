/**
 * L4 客户侧演示 agent（合约 §2.1 的 `client` 角色）。
 *
 * 它扮演的是**客户**，不是 Citely：
 * - 用客户钱包 `createJob` 开单、`approve`+`fund` 把案件费打进 8183 托管；
 * - 拿到 Citely 出具的 SA 后，**按自有预设策略核验并自行决定是否执行付款**
 *   （`policy.ts`）。SA 是条件证明，不是 Citely 授权付款；
 * - 付款目标恒为 SA 里的**收款方**，客户资金永不进我方地址（不变量 3）。
 *
 * 本文件不持有任何密钥：链上写操作交给注入的 `JobClient`（由客户钱包驱动），
 * 对收款方的付款交给注入的 {@link PaymentExecutor}。这样"谁签的名"在依赖注入
 * 处一目了然，也让单测能零网络零密钥跑完整流程。
 */

import type { CreateJobParams, JobClient } from "@citely/chain";
import type { Hex } from "viem";

import { applySettlementPolicy } from "./policy.js";
import type { PlannedPayment, SettlementDecision, WalletSettlementPolicy } from "./policy.js";
import { observeSa } from "./sa-view.js";
import type { ObservedSa } from "./sa-view.js";

/** 钱包把钱付给收款方的出口。演示里由 demo 注入实现（`--dry-run` 时只记账不发交易）。 */
export interface PaymentExecutor {
  /**
   * 向收款方转账。
   *
   * @param payment - 钱包决定的一笔付款
   * @returns 交易哈希
   */
  payOut(payment: PlannedPayment): Promise<Hex>;
}

/** 客户开单参数。刻意不含自由文本——`description` 由本 agent 生成。 */
export interface OpenCaseParams {
  readonly caseId: string;
  /** Citely 运营钱包（8183 provider）。 */
  readonly provider: CreateJobParams["provider"];
  /** Citely 验证器钱包（8183 evaluator）。 */
  readonly evaluator: CreateJobParams["evaluator"];
  /** Unix 秒。超过它 client 可 `claimRefund`。 */
  readonly expiredAt: bigint;
}

/** `createJob` 的 `description` 允许的 caseId 形状：只有 ASCII 标识符字符。 */
const CASE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 链上 `description` 前缀。全字段只有它加一个不透明 caseId。 */
export const CASE_DESCRIPTION_PREFIX = "citely-case:";

/** 参数不满足客户侧前置条件。 */
export class MarketplaceAgentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MarketplaceAgentError";
  }
}

/**
 * 构造上链的 `description`。
 *
 * 不变量 4：链上只有哈希、签名、状态、资金。案件描述、材料、报告原文一个字都不上链，
 * `description` 里只放一个**不透明案件引用**，业务内容留在链下卷宗。
 *
 * @param caseId - 案件标识（只允许 ASCII 标识符字符）
 * @returns 形如 `citely-case:<caseId>` 的字符串
 * @throws {MarketplaceAgentError} caseId 形状非法（可能夹带自由文本）
 */
export function buildCaseDescription(caseId: string): string {
  if (!CASE_ID_SHAPE.test(caseId)) {
    throw new MarketplaceAgentError(
      "caseId must be an opaque ASCII identifier; free text must never reach on-chain calldata",
    );
  }
  return `${CASE_DESCRIPTION_PREFIX}${caseId}`;
}

/** 核验 + 付款的结果。 */
export interface SettlementRun {
  readonly sa: ObservedSa;
  readonly decision: SettlementDecision;
  /** 与 `decision.payments` 一一对应的交易哈希；不执行时为空。 */
  readonly payoutTxHashes: readonly Hex[];
}

/** {@link MarketplaceAgent} 的构造依赖。 */
export interface MarketplaceAgentDeps {
  /** 由**客户钱包**驱动的 8183 客户端。 */
  readonly jobClient: JobClient;
  readonly paymentExecutor: PaymentExecutor;
  /** 钱包主人事先配置的结算策略。 */
  readonly policy: WalletSettlementPolicy;
}

/**
 * 客户侧演示 agent。
 *
 * 生命周期：{@link openCase} → {@link fundCase} →（Citely 判定、出具 SA）→
 * {@link reviewAndSettle}。
 */
export class MarketplaceAgent {
  readonly #deps: MarketplaceAgentDeps;

  public constructor(deps: MarketplaceAgentDeps) {
    this.#deps = deps;
  }

  /**
   * 开一单 8183 Job（client 调）。
   *
   * @param params - 案件标识与三方地址
   * @returns jobId 与交易哈希
   */
  public async openCase(params: OpenCaseParams): Promise<{ jobId: bigint; txHash: Hex }> {
    const description = buildCaseDescription(params.caseId);
    const { jobId, txHash } = await this.#deps.jobClient.createJob({
      caseId: params.caseId,
      provider: params.provider,
      evaluator: params.evaluator,
      expiredAt: params.expiredAt,
      description,
    });
    return { jobId, txHash };
  }

  /**
   * `approve` + `fund`：把案件费打进 8183 托管（client 调，Open→Funded）。
   *
   * 托管方是 8183 合约本身，不是任何 Citely 地址——`fund` 之后这笔钱的去向
   * 只由合约的终局函数决定（合约 §2.3）。
   *
   * `expectedBudgetAtomic` 是抢跑缓解（合约 §2.5）：参考实现的 `fund` 没有
   * `expectedBudget` 检查，provider 可以在客户看过报价与实际 `fund` 之间抬价。
   * 客户方在发交易前紧邻复读链上 budget，与自己批准的数不符即中止——
   * **这是客户自己的钱，这道闸只能由客户来把**。
   *
   * @param jobId - 8183 jobId
   * @param expectedBudgetAtomic - 客户批准的案件费（6 位小数原子单位）
   * @returns 交易哈希
   */
  public async fundCase(jobId: bigint, expectedBudgetAtomic: bigint): Promise<Hex> {
    return await this.#deps.jobClient.fund(jobId, expectedBudgetAtomic);
  }

  /**
   * 超期后取回托管资金（Funded/Submitted 且已过 `expiredAt` → Expired）。
   *
   * ⚠️ 参考实现的 `claimRefund` **没有 `msg.sender` 检查（permissionless）**，
   * 任何人都能替客户触发退款。我方仍由 client 角色调用，但**不许**据此
   * 做"只有 client 能退款"的安全推断。
   *
   * @param jobId - 8183 jobId
   * @returns 交易哈希
   */
  public async claimRefund(jobId: bigint): Promise<Hex> {
    return await this.#deps.jobClient.claimRefund(jobId);
  }

  /**
   * 核验一份 SA 并按自有预设策略决定是否执行付款。
   *
   * **这里没有"Citely 说付就付"这条路径**：SA 只提供条件证明，
   * 放行与否完全由 {@link WalletSettlementPolicy} 决定。
   *
   * @param params - SA 的原始 JSON（不可信）、已资助的 jobId、判定时刻
   * @returns 钱包视图、核验结论与实际发出的付款交易哈希
   */
  public async reviewAndSettle(params: {
    readonly saJson: unknown;
    readonly fundedJobId: bigint;
    readonly now?: Date;
  }): Promise<SettlementRun> {
    const sa = observeSa(params.saJson);
    const decision = applySettlementPolicy({
      sa,
      policy: this.#deps.policy,
      fundedJobId: params.fundedJobId,
      now: params.now ?? new Date(),
    });

    if (!decision.execute) {
      return { sa, decision, payoutTxHashes: [] };
    }

    const payoutTxHashes: Hex[] = [];
    for (const payment of decision.payments) {
      // 串行发送：钱包 nonce 是串行资源，并发会撞 nonce。
      payoutTxHashes.push(await this.#deps.paymentExecutor.payOut(payment));
    }
    return { sa, decision, payoutTxHashes };
  }
}
