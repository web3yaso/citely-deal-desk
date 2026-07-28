import type { Hex } from "viem";

import { redactSecrets } from "./config/redact.js";
import type { ChainAction } from "./types/idempotency.js";

/** {@link ChainError} 的上下文，全部字段可选（不同失败点能拿到的信息不同）。 */
export interface ChainErrorContext {
  readonly action?: ChainAction;
  readonly jobId?: bigint;
  readonly caseId?: string;
  readonly txHash?: Hex;
  /** 幂等键，便于对账时定位 `tx_log` 行 */
  readonly idempotencyKey?: string;
}

/**
 * 链上/采购操作的类型化错误。
 *
 * 不吞异常：底层错误一律挂在 `cause` 上，消息里带够定位所需的上下文。
 * 构造时消息已过 {@link redactSecrets}，不会把私钥带进日志。
 */
export class ChainError extends Error {
  override readonly name = "ChainError";
  readonly context: ChainErrorContext;

  constructor(
    message: string,
    context: ChainErrorContext = {},
    options?: { cause?: unknown; secrets?: readonly (string | undefined)[] },
  ) {
    const parts: string[] = [];
    if (context.action !== undefined) parts.push(`action=${context.action}`);
    if (context.jobId !== undefined) parts.push(`jobId=${context.jobId.toString()}`);
    if (context.caseId !== undefined) parts.push(`caseId=${context.caseId}`);
    if (context.idempotencyKey !== undefined) parts.push(`key=${context.idempotencyKey}`);
    if (context.txHash !== undefined) parts.push(`txHash=${context.txHash}`);
    const suffix = parts.length > 0 ? ` [${parts.join(" ")}]` : "";
    const secrets = options?.secrets ?? [];

    super(redactSecrets(`${message}${suffix}`, ...secrets), { cause: options?.cause });
    this.context = context;
  }
}

/**
 * 把任意 catch 到的值包装成带上下文的 {@link ChainError}，原错误进 `cause`。
 *
 * @param error - catch 到的值
 * @param message - 补充说明"在做什么时失败"
 * @param context - 定位上下文
 * @param secrets - 需要从消息中屏蔽的密钥
 */
export function wrapChainError(
  error: unknown,
  message: string,
  context: ChainErrorContext = {},
  secrets: readonly (string | undefined)[] = [],
): ChainError {
  const detail = error instanceof Error ? error.message : String(error);
  return new ChainError(`${message}：${detail}`, context, { cause: error, secrets });
}
