/**
 * 把 HTTP 层的 {@link RunCaseRequest} 适配成 engine 的 `CaseRequest`。
 *
 * 这一层刻意做薄且**可单测**：真正的链上客户端、判定器、数据库全部在
 * `index.ts` 里构造后注入，这里只负责"HTTP 请求 + 服务侧配置 → 编排入参"这一次翻译。
 * 服务侧配置（provider / evaluator / 案件费 / Module 报价）不该由调用方决定，
 * 请求侧参数（收款方 / 金额 / 到期时刻）不该由服务端猜——两者的边界就在这个函数里。
 */

import type { ModuleId } from "@citely/chain";
import type {
  CaseRequest,
  RunCaseDeps,
  VerificationReportView,
} from "@citely/engine/orchestrator";
import type { LoadedRubric } from "@citely/engine/rubric";
import type { Usdc6 } from "@citely/engine";
import type { Address } from "viem";

import type { CaseRunner, RunCaseRequest, RunCaseResult } from "./ports.js";

/** 服务侧固定的编排参数（来自环境配置，不由调用方指定）。 */
export interface CaseRunnerConfig {
  /** 8183 provider = 运营地址。 */
  readonly provider: Address;
  /** 8183 evaluator = 验证器地址（公开信息）。 */
  readonly evaluator: Address;
  /** 案件费（escrow 预算）。 */
  readonly caseBudget: Usdc6;
  readonly moduleId: ModuleId;
  /** Module 报价，进账本的 `amount_nominal`。 */
  readonly modulePrice: Usdc6;
  readonly chainId: number;
  readonly rubric: LoadedRubric;
}

/**
 * `runCase` 的注入形状。抽成类型是为了让本文件不 import engine 的实现。
 *
 * 泛型透传到底：三检报告的具体类型（进程内是验证器的完整 `VerificationReport`，
 * 远端是结构化视图）不该在这一层被抹平——抹平了收口那边就拿不到该有的字段。
 */
export type RunCaseFn<TReport extends VerificationReportView = VerificationReportView> = (
  request: CaseRequest,
  deps: RunCaseDeps<TReport>,
) => Promise<RunCaseResult>;

/**
 * 把 HTTP 请求翻成 engine 的 `CaseRequest`。
 *
 * `expiredAt` 用**秒**（8183 的 `expiredAt` 是 Unix 秒）；调用方给的是 ISO 时刻。
 *
 * @param request - 已校验的 HTTP 请求
 * @param config - 服务侧固定参数
 * @returns engine 的编排入参
 */
export function toCaseRequest(request: RunCaseRequest, config: CaseRunnerConfig): CaseRequest {
  return {
    // deal_id 即案件幂等键：同一个 id 重发不会重复建 Job / 重复付费 / 重复入账。
    caseId: request.deal.deal_id,
    deal: request.deal,
    rubric: config.rubric,
    module: { id: config.moduleId, quotedPriceAtomic: config.modulePrice },
    job: {
      provider: config.provider,
      evaluator: config.evaluator,
      expiredAt: BigInt(Math.floor(request.expiresAt.getTime() / 1000)),
      budgetAtomic: config.caseBudget,
    },
    settlement: {
      party: request.settlement.party,
      payee: request.settlement.payee,
      amountAtomic: request.settlement.amountAtomic,
    },
    chainId: config.chainId,
  };
}

/**
 * 创建编排端口的生产实现。
 *
 * @param runCase - engine 的 `runCase`
 * @param deps - 已构造好的依赖（链上客户端、判定器、仓储、验证器端口）
 * @param config - 服务侧固定参数
 * @returns 可注入 `createApp` 的 {@link CaseRunner}
 */
export function createCaseRunner<TReport extends VerificationReportView>(
  runCase: RunCaseFn<TReport>,
  deps: RunCaseDeps<TReport>,
  config: CaseRunnerConfig,
): CaseRunner {
  return {
    runCase: (request) => runCase(toCaseRequest(request, config), deps),
  };
}
