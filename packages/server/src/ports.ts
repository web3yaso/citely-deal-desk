/**
 * server 与其余包之间的**端口**（全部是类型，无运行时代码）。
 *
 * server 刻意不直接调 engine 的 `runCase()` 与 chain 的收费中间件，而是在这里
 * 声明所需形状、由 `index.ts` 在进程启动时适配注入。两个理由：
 *
 * 1. HTTP 层与它的测试不需要真数据库、真链、真判定器就能跑；
 * 2. **验证器进程拆分全靠注入**——engine 的 `RunCaseDeps` 把三检（`verify`）
 *    与收口（`settle`）做成了端口，主服务注入的是打到独立验证器服务的 HTTP
 *    客户端，因此**不需要持有 `VERIFIER_PRIVATE_KEY`**（合约 §8 密钥纪律）。
 *
 * 结果类型直接复用 engine 的 {@link CaseResult}，**不另造一套平行形状**：
 * 两套形状之间的翻译层是丢字段、错语义的常见来源。HTTP 该做的是**投影**
 * （bigint → 字符串等），投影写在 `app.ts` 里，明面上可见。
 *
 * 全部用 `import type`：`verbatimModuleSyntax` 下类型导入被完整擦除，
 * 所以这些声明不会把 better-sqlite3 / openai 拉进进程。
 */

import type { CaseExitReason, CaseState } from "@citely/engine/db";
import type { CaseResult, CaseRunSnapshot } from "@citely/engine/orchestrator";
import type { MiddlewareHandler } from "hono";

import type { CaseRequestBody } from "./case-request.js";

/**
 * 一次 x402 收款的凭证标识。
 *
 * **只存标识，不存签名材料**：它会进案件记录并可能被回显，
 * 放进签名就等于把可重放的付款授权写进了日志。
 */
export interface PaymentReceipt {
  /** 付款凭证 ID（同一凭证重试不重复收费）。 */
  readonly credentialId?: string;
}

/**
 * 一次案件请求：已校验的请求体 + 本次收款凭证。
 *
 * `deal.deal_id` 同时是案件的幂等键——同一个 id 重发不会重复建 Job、
 * 重复付费、重复入账（engine 的请求级幂等）。
 */
export interface RunCaseRequest extends CaseRequestBody {
  /** 本次收款的凭证标识（未收费模式下缺省）。 */
  readonly payment?: PaymentReceipt;
}

/** 编排结果：engine 的原始结果，投影留给 HTTP 层。 */
export type RunCaseResult = CaseResult;

/**
 * 编排端口：跑完一个案件。生产实现是 engine `runCase()` 的适配
 * （补齐 rubric / module / job / settlement 等服务侧配置）。
 */
export interface CaseRunner {
  runCase(request: RunCaseRequest): Promise<RunCaseResult>;
}

/**
 * 案件查询结果。
 *
 * `snapshot` 是 engine 明确保证 **JSON 安全**的运行快照（无 bigint、无 Date），
 * 因此可以原样回给调用方；案件尚未产出 SA 时为 `null`。
 */
export interface CaseRecord {
  readonly caseId: string;
  readonly state: CaseState;
  readonly exitReason?: CaseExitReason;
  readonly jobId: string | null;
  readonly snapshot: CaseRunSnapshot | null;
  readonly updatedAt: string;
}

/** 查询端口：按 id 读案件。生产实现是 engine `CaseStore` + `CaseRunStore` 的适配。 */
export interface CaseReader {
  readCase(caseId: string): Promise<CaseRecord | undefined>;
}

/**
 * x402 卖方中间件端口。生产实现是 chain 的 `createPaidRoute()`。
 *
 * 中间件负责 402 应答与凭证校验；**server 不解析付款材料**，
 * 只通过 {@link PaymentReceiptExtractor} 取回可安全回显的标识。
 */
export type PaymentGate = MiddlewareHandler;

/** 从已通过收费闸的请求里取出凭证标识（取不到返回 `undefined`）。 */
export type PaymentReceiptExtractor = (request: Request) => PaymentReceipt | undefined;
