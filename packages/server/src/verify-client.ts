/**
 * 远端验证器客户端：把 engine 的 `verify` / `settle` 两个端口打到**独立进程**。
 *
 * ## 为什么是一次调用而不是两次
 *
 * engine 依次调 `verify(sa …)` 再调 `settle({jobId, report})`。若照搬成两个
 * HTTP 端点，`/settle` 就会接受**调用方递过来的三检报告**——主服务大可以编一份
 * `passed: true` 让验证器照签，独立验证器的全部价值当场归零。
 *
 * 所以远端只暴露一个 `POST /verify-and-settle`：验证器**自己跑三检、自己决定收口**，
 * 主服务无从干预结论。本客户端把这一次调用拆回两个端口：
 * `verify` 发起调用并记住收口结果，`settle` 取回那个结果。
 *
 * `jobId` 不由主服务传——它取自 **SA 里签过名的** `bound_to.job_id`，
 * 比任何请求参数都更可信。`settle` 只做一致性断言。
 *
 * ## 密钥纪律
 *
 * 本文件所在的主服务进程**不持有 `VERIFIER_PRIVATE_KEY`**：收口交易由验证器
 * 用它自己的钥匙发。共享令牌只用于这一对内部调用，**绝不进日志、绝不进 agent card**。
 */

import type {
  SettlementActionView,
  SettlePort,
  VerificationReportView,
  VerifyPort,
  VerifyRequest,
} from "@citely/engine/orchestrator";
import type { Hex } from "viem";

/** 远端验证器返回的形状。 */
export interface VerifyAndSettleResponse {
  readonly verification: VerificationReportView;
  readonly settlement: SettlementActionView;
}

export interface RemoteVerifierOptions {
  /** 验证器服务基地址（内部地址，绝不出现在对外文档里）。 */
  readonly baseUrl: string;
  /** 内部调用共享令牌。 */
  readonly token: string;
  /** 注入 fetch，测试用；默认全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次调用超时（毫秒）。 */
  readonly timeoutMs?: number;
}

/** 远端验证器调用失败。message **不含令牌**。 */
export class RemoteVerifierError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RemoteVerifierError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** 三检 + 收口的远端实现（供 engine `RunCaseDeps` 注入）。 */
export interface RemoteVerifier {
  readonly verify: VerifyPort;
  readonly settle: SettlePort;
}

function assertOutcome(value: unknown): asserts value is VerifyAndSettleResponse {
  if (typeof value !== "object" || value === null) {
    throw new RemoteVerifierError("验证器响应不是对象");
  }
  const body = value as Record<string, unknown>;
  const verification = body["verification"];
  const settlement = body["settlement"];
  if (typeof verification !== "object" || verification === null) {
    throw new RemoteVerifierError("验证器响应缺少 verification");
  }
  const report = verification as Record<string, unknown>;
  if (typeof report["passed"] !== "boolean" || typeof report["reasonHash"] !== "string") {
    throw new RemoteVerifierError("验证器响应的 verification 形状非法");
  }
  if (!Array.isArray(report["outcomes"])) {
    throw new RemoteVerifierError("验证器响应的 outcomes 不是数组");
  }
  if (typeof settlement !== "object" || settlement === null) {
    throw new RemoteVerifierError("验证器响应缺少 settlement");
  }
  const action = settlement as Record<string, unknown>;
  if (action["action"] !== "complete" && action["action"] !== "reject") {
    throw new RemoteVerifierError("验证器响应的 settlement.action 非法");
  }
  if (typeof action["txHash"] !== "string") {
    throw new RemoteVerifierError("验证器响应的 settlement.txHash 非法");
  }
}

/**
 * 创建远端验证器的 `verify` / `settle` 端口对。
 *
 * @param options - 基地址、令牌与注入项
 * @returns 可直接塞进 engine `RunCaseDeps` 的两个端口
 * @throws {RemoteVerifierError} 网络失败、非 2xx、或响应形状非法
 */
export function createRemoteVerifier(options: RemoteVerifierOptions): RemoteVerifier {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  // 一次案件里 verify 紧接着 settle，这里只需暂存一跳。
  const settledBySaHash = new Map<Hex, { jobId: string; action: SettlementActionView }>();

  async function call(request: VerifyRequest): Promise<VerifyAndSettleResponse> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/verify-and-settle`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      // 带上下文重抛，不吞错；**不回显 URL 之外的任何配置**。
      throw new RemoteVerifierError("验证器服务不可达", { cause: error });
    }

    if (!response.ok) {
      throw new RemoteVerifierError(`验证器服务返回 ${String(response.status)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      throw new RemoteVerifierError("验证器响应不是有效 JSON", { cause: error });
    }
    assertOutcome(body);
    return body;
  }

  const verify: VerifyPort = async (request) => {
    const outcome = await call(request);
    settledBySaHash.set(request.sa.attestation.sa_hash, {
      jobId: request.sa.bound_to.job_id,
      action: outcome.settlement,
    });
    return outcome.verification;
  };

  const settle: SettlePort = (request) => {
    // 找回上一步那次调用的收口结果。engine 是 verify 紧接 settle，找不到即接线错了。
    for (const [saHash, entry] of settledBySaHash) {
      if (entry.jobId !== request.jobId.toString()) continue;
      settledBySaHash.delete(saHash);
      return Promise.resolve(entry.action);
    }
    return Promise.reject(
      new RemoteVerifierError(
        `job ${request.jobId.toString()} 没有对应的验证器收口结果；` +
          "settle 必须紧跟同一案件的 verify",
      ),
    );
  };

  return { verify, settle };
}
