/**
 * Deal Desk 的 HTTP 应用（卖方侧）。
 *
 * 结构照上游 msb-agent 的 `src/http/app.ts`：访问日志 → 限流 → 体积闸 →
 * **收费前校验** → x402 收费 → 业务。
 *
 * 全部外部能力经端口注入（见 `ports.ts`），因此本文件不 import engine 的
 * `runCase()`、chain 的收费中间件、更不 import `@citely/verifier`——
 * 主服务进程不该有能力在本地跑验证器（那样就没有"独立密钥"可言了）。
 */

import { safeErrorMessage } from "@citely/chain";
import { createLogger } from "@citely/engine";
import type { Logger } from "@citely/engine";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { buildAgentCard, buildAgentRegistration } from "./agent-card.js";
import type { AgentCardInput } from "./agent-card.js";
import { AGENT_ICON_BYTES, AGENT_ICON_CONTENT_TYPE } from "./agent-icon.js";
import {
  AGENT_IMAGE_PATH,
  AGENT_NAME,
  CAPABILITIES,
  DISCLAIMER,
  MAX_CASE_BODY_BYTES,
  REPOSITORY_URL,
} from "./constants.js";
import { parseCaseRequest } from "./case-request.js";
import { createRateLimiter } from "./rate-limit.js";
import type {
  CaseReader,
  CaseRunner,
  PaymentGate,
  PaymentReceipt,
  PaymentReceiptExtractor,
  RunCaseResult,
} from "./ports.js";

/** 案件 id 的形状闸：路径参数直接进存储查询，先卡形状再说。 */
const CASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly trustProxyHeader: boolean;
}

export interface CreateAppOptions {
  readonly caseRunner: CaseRunner;
  readonly caseReader: CaseReader;
  /** x402 收费中间件；缺省即不收费（仅本地联调）。 */
  readonly paymentGate?: PaymentGate;
  /** 从已付款请求里取回凭证标识。 */
  readonly readPayment?: PaymentReceiptExtractor;
  readonly card: AgentCardInput;
  readonly rateLimit?: RateLimitOptions;
  readonly logger?: Logger;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60_000,
  maxRequests: 60,
  trustProxyHeader: true,
};

/** 业务响应统一带免责声明——对外每一句话都要跟 card 上写的一致。 */
function withDisclaimer<T extends Record<string, unknown>>(
  body: T,
): T & { disclaimer: string } {
  return { ...body, disclaimer: DISCLAIMER };
}

/**
 * 账本行的对外投影。
 *
 * 金额是 `Usdc6`（分支 bigint），`JSON.stringify` 遇 bigint 会直接抛——
 * 所以必须在这里显式转成十进制字符串，不能指望序列化器。
 */
function projectLedger(entries: RunCaseResult["ledger"]): readonly Record<string, unknown>[] {
  return entries.map((entry) => ({
    account: entry.account,
    direction: entry.direction,
    category: entry.category,
    amount_nominal: entry.amount_nominal.toString(),
    amount_actual: entry.amount_actual.toString(),
    ref: entry.ref,
    ref_type: entry.ref_type,
    case_id: entry.caseId,
    // 结算尚未发生时为 null——**空值是诚实的，假 txHash 不是**。
    settlement_tx: entry.settlement_tx,
  }));
}

/** 编排结果的对外投影：bigint 转字符串，字段名转 snake_case 与 SA 保持一致。 */
function projectResult(result: RunCaseResult): Record<string, unknown> {
  return {
    case_id: result.caseId,
    job_id: result.jobId.toString(),
    routing: {
      exit: result.routing.exit,
      chain_action: result.routing.chainAction,
      actor: result.routing.actor,
      reason: result.routing.reason,
    },
    sa: result.sa,
    sa_hash: result.saHash,
    verification: {
      passed: result.verification.passed,
      reason_hash: result.verification.reasonHash,
      outcomes: result.verification.outcomes,
    },
    // 未收口（如出口 3 等采购）时为 null，如实显示。
    settlement: result.settlement,
    procurement: result.procurement,
    // 出口 4 的会谈卷宗正文（链下，不变量 4：链上只有它的哈希）。
    // 回给**付了钱的案件所有者**——那是他自己的案件材料，且出口 4 没有它就没法走下去。
    briefing_pack: result.briefingPack,
    ledger: projectLedger(result.ledger),
    /** `true` = 命中请求级幂等，这次一步都没重跑（没建 Job、没付费、没入账）。 */
    replayed: result.replayed,
  };
}

function registerMetaRoutes(app: Hono, card: AgentCardInput): void {
  app.get("/", (context) =>
    context.json(
      withDisclaimer({
        name: AGENT_NAME,
        endpoints: {
          create_case: "POST /cases (x402 paid)",
          read_case: "GET /cases/{case_id}",
          agent_card: "/.well-known/agent-card.json",
          agent_registration: "/.well-known/agent-registration.json",
          health: "/health",
        },
        capabilities: CAPABILITIES.map((capability) => capability.id),
        repository: REPOSITORY_URL,
      }),
    ),
  );

  // card 的 `image` 指向这里。可长缓存：图不常换，而索引与钱包会反复来抓。
  app.get(AGENT_IMAGE_PATH, (context) => {
    context.header("Content-Type", AGENT_ICON_CONTENT_TYPE);
    context.header("Cache-Control", "public, max-age=86400");
    return context.body(AGENT_ICON_BYTES);
  });

  app.get("/health", (context) => context.json({ status: "ok", disclaimer: DISCLAIMER }));
  // 兼容上游 msb-agent 的命名，两个路径同义。
  app.get("/healthz", (context) => context.json({ status: "ok", disclaimer: DISCLAIMER }));

  app.get("/.well-known/agent-card.json", (context) => {
    context.header("Cache-Control", "public, max-age=300");
    return context.json(buildAgentCard(card));
  });

  app.get("/.well-known/agent-registration.json", (context) => {
    const registration = buildAgentRegistration(card);
    if (registration === undefined) {
      return context.json(
        withDisclaimer({
          error: "agent_not_registered",
          message: "No ERC-8004 on-chain identity is configured for this deployment.",
        }),
        404,
      );
    }
    context.header("Cache-Control", "public, max-age=300");
    return context.json(registration);
  });
}

function registerCaseRead(app: Hono, caseReader: CaseReader): void {
  app.get("/cases/:id", async (context) => {
    const caseId = context.req.param("id");
    if (!CASE_ID_PATTERN.test(caseId)) {
      return context.json(
        withDisclaimer({ error: "invalid_case_id", message: "Malformed case id." }),
        400,
      );
    }
    const record = await caseReader.readCase(caseId);
    if (record === undefined) {
      return context.json(withDisclaimer({ error: "case_not_found", message: "No such case." }), 404);
    }
    return context.json(
      withDisclaimer({
        case_id: record.caseId,
        state: record.state,
        ...(record.exitReason === undefined ? {} : { exit_reason: record.exitReason }),
        job_id: record.jobId,
        // 快照是 engine 保证的 JSON 安全结构，原样回；尚无 SA 时为 null。
        snapshot: record.snapshot,
        updated_at: record.updatedAt,
      }),
    );
  });
}

/**
 * 创建 Deal Desk HTTP 应用。
 *
 * @param options - 端口注入、agent card 输入与限流参数
 * @returns 已装配好路由的 hono 应用
 */
export function createApp(options: CreateAppOptions): Hono {
  const log = options.logger ?? createLogger("server");
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
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

  // 不吞错：日志里留下带上下文的原因（已过 redact），对外只回一句通用消息，
  // 避免把内部结构/地址泄给调用方。
  app.onError((error, context) => {
    log.error("request failed", {
      path: context.req.path,
      error: safeErrorMessage(error),
    });
    return context.json(
      withDisclaimer({
        error: "internal_error",
        message: "Case execution failed. A paid request can be retried with the same payment proof.",
      }),
      500,
    );
  });

  app.use(
    "*",
    createRateLimiter({
      ...rateLimit,
      shouldSkip: (context) =>
        context.req.method === "GET" &&
        (context.req.path === "/health" || context.req.path === "/healthz"),
    }),
  );

  app.use(
    "/cases",
    bodyLimit({
      maxSize: MAX_CASE_BODY_BYTES,
      onError: (context) =>
        context.json(
          withDisclaimer({
            error: "request_too_large",
            message: `请求体不得超过 ${String(MAX_CASE_BODY_BYTES / 1024)}KB`,
          }),
          413,
        ),
    }),
  );

  // **校验在收费之前**：无效请求不进支付流程，不让人付了钱才知道参数写错。
  app.use("/cases", async (context, next) => {
    if (context.req.method !== "POST") {
      await next();
      return undefined;
    }
    let body: unknown;
    try {
      body = await context.req.raw.clone().json();
    } catch {
      return context.json(
        withDisclaimer({
          error: "invalid_request",
          issues: [{ path: "", message: "Request body must be valid JSON." }],
        }),
        400,
      );
    }
    const parsed = parseCaseRequest(body);
    if (!parsed.ok) {
      return context.json(withDisclaimer({ error: "invalid_request", issues: parsed.issues }), 400);
    }
    await next();
    return undefined;
  });

  if (options.paymentGate !== undefined) {
    app.use("/cases", options.paymentGate);
  }

  app.post("/cases", async (context) => {
    // 上面的收费前校验已经把形状卡过一遍，这里必然通过；重跑一次是因为
    // 中间件之间不共享解析结果，且重复校验的代价远低于漏校验的代价。
    const parsed = parseCaseRequest(await context.req.raw.clone().json());
    if (!parsed.ok) {
      return context.json(withDisclaimer({ error: "invalid_request", issues: parsed.issues }), 400);
    }
    const payment: PaymentReceipt | undefined = options.readPayment?.(context.req.raw);
    const result = await options.caseRunner.runCase({
      ...parsed.value,
      ...(payment === undefined ? {} : { payment }),
    });
    // 重放（命中幂等）回 200，本次真跑了回 201——让调用方能分辨"这次到底有没有发生事情"。
    return context.json(withDisclaimer(projectResult(result)), result.replayed ? 200 : 201);
  });

  registerCaseRead(app, options.caseReader);
  registerMetaRoutes(app, options.card);

  return app;
}
