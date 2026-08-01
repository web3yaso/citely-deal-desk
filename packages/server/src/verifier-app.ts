/**
 * 验证器侧 HTTP 应用——**独立进程、独立密钥**（合约 §8）。
 *
 * 这个进程是 Railway 上的第二个服务，环境里**只注入 `VERIFIER_PRIVATE_KEY`**，
 * 另外五把钥匙与 `OPENAI_API_KEY` 根本不存在于它的环境（`packages/verifier` 的
 * `FORBIDDEN_ENV_VARS` 负向测试因此保持有效）。
 *
 * 只有一个业务端点 `POST /verify-and-settle`：三检与收口**在同一次调用里**完成。
 * 拆成两个端点就意味着 `/settle` 要接受调用方递来的三检报告——那样主服务
 * 编一份 `passed: true` 就能让验证器照签，独立验证器的价值归零。
 *
 * 收口用的 `jobId` 取自 **SA 里签过名的** `bound_to.job_id`，不接受请求参数指定。
 */

import { safeErrorMessage } from "@citely/chain";
import { createLogger } from "@citely/engine";
import type { Logger } from "@citely/engine";
import type {
  SettlementActionView,
  SettlePort,
  VerificationReportView,
  VerifyPort,
  VerifyRequest,
} from "@citely/engine/orchestrator";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { createRateLimiter } from "./rate-limit.js";
import type { RateLimitOptions } from "./app.js";

/** 三检请求体上限。SA + rubric 都不大，给 1MB 足够且能挡住撑爆内存的请求。 */
const MAX_VERIFY_BODY_BYTES = 1024 * 1024;

const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60_000,
  maxRequests: 120,
  trustProxyHeader: true,
};

export interface CreateVerifierAppOptions {
  /** 三检实现（生产实现是 verifier 的 `verifySettlementAuthorization` 绑好信任根）。 */
  readonly verify: VerifyPort;
  /** 收口实现（生产实现是 verifier 的 `settleVerifiedJob`，用验证器密钥发交易）。 */
  readonly settle: SettlePort;
  /** 内部调用共享令牌。 */
  readonly token: string;
  readonly rateLimit?: RateLimitOptions;
  readonly logger?: Logger;
}

/**
 * 定长比较两个令牌。
 *
 * 先各自 sha256 再比：`timingSafeEqual` 要求等长入参，直接比原串会因长度差异
 * 抛错/提前返回，把令牌长度泄给攻击者。
 */
function tokensMatch(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function readBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `0x` + 64 位十六进制。 */
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** 十进制正整数字符串（jobId）。 */
const JOB_ID_PATTERN = /^\d{1,78}$/;

interface ParsedVerifyBody {
  readonly request: VerifyRequest;
  readonly jobId: bigint;
}

/**
 * 校验 `/verify-and-settle` 的请求体。
 *
 * 只卡**结构**：SA 的真假由三检自己判断（签名、Module 认证、交付物哈希），
 * 这里多做一层语义判断反而会出现两套口径。
 */
function parseVerifyBody(raw: unknown): ParsedVerifyBody | string {
  if (!isRecord(raw)) return "请求体必须是 JSON 对象";
  const sa = raw["sa"];
  if (!isRecord(sa)) return "sa 必须是对象";

  const boundTo = sa["bound_to"];
  if (!isRecord(boundTo)) return "sa.bound_to 必须是对象";
  const jobId = boundTo["job_id"];
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    return "sa.bound_to.job_id 必须是十进制整数字符串";
  }

  const attestation = sa["attestation"];
  if (!isRecord(attestation) || typeof attestation["sa_hash"] !== "string") {
    return "sa.attestation.sa_hash 缺失";
  }

  if (!isRecord(raw["rubric"])) return "rubric 必须是对象";

  const submitted = raw["submittedDeliverableHash"];
  if (typeof submitted !== "string" || !HASH_PATTERN.test(submitted)) {
    return "submittedDeliverableHash 必须是 0x + 64 位十六进制";
  }

  const chainId = raw["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return "chainId 必须是正整数";
  }

  return {
    // 形状已逐项校验；SA / rubric 的语义真假交给三检本身判断。
    request: {
      sa: sa as unknown as VerifyRequest["sa"],
      rubric: raw["rubric"] as unknown as VerifyRequest["rubric"],
      submittedDeliverableHash: submitted as `0x${string}`,
      chainId,
    },
    jobId: BigInt(jobId),
  };
}

interface VerifyAndSettleResult {
  readonly verification: VerificationReportView;
  readonly settlement: SettlementActionView;
}

/**
 * 创建验证器 HTTP 应用。
 *
 * @param options - 三检 / 收口实现与内部令牌
 * @returns 已装配好路由的 hono 应用
 * @throws {Error} 令牌为空（空令牌等于不设防）
 */
export function createVerifierApp(options: CreateVerifierAppOptions): Hono {
  if (options.token.trim() === "") {
    throw new Error("INTERNAL_SERVICE_TOKEN 不得为空");
  }
  const log = options.logger ?? createLogger("verifier-server");
  const app = new Hono();

  app.use("*", async (context, next) => {
    const startedAt = Date.now();
    await next();
    log.info("request", {
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      duration_ms: Date.now() - startedAt,
    });
  });

  app.onError((error, context) => {
    log.error("verify failed", { path: context.req.path, error: safeErrorMessage(error) });
    return context.json({ error: "internal_error", message: "Verification checks failed to execute." }, 500);
  });

  app.use("*", createRateLimiter({ ...(options.rateLimit ?? DEFAULT_RATE_LIMIT) }));

  app.get("/health", (context) => context.json({ status: "ok", role: "verifier" }));

  app.use(
    "/verify-and-settle",
    bodyLimit({
      maxSize: MAX_VERIFY_BODY_BYTES,
      onError: (context) =>
        context.json({ error: "request_too_large", message: "Request body too large." }, 413),
    }),
  );

  // 鉴权：内部端点，没有令牌一律 401，且不透露原因细节。
  app.use("/verify-and-settle", async (context, next) => {
    const provided = readBearer(context.req.header("authorization"));
    if (provided === undefined || !tokensMatch(provided, options.token)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    await next();
    return undefined;
  });

  app.post("/verify-and-settle", async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json<unknown>();
    } catch {
      return context.json({ error: "invalid_request", message: "Request body must be valid JSON." }, 400);
    }

    const parsed = parseVerifyBody(raw);
    if (typeof parsed === "string") {
      return context.json({ error: "invalid_request", message: parsed }, 400);
    }

    // 三检与收口在同一次调用里完成：结论由验证器自己产出，调用方无从代签。
    const verification = await options.verify(parsed.request);
    const settlement = await options.settle({ jobId: parsed.jobId, report: verification });
    const result: VerifyAndSettleResult = { verification, settlement };
    return context.json(result);
  });

  return app;
}
