import { createHash } from "node:crypto";

/**
 * 已付款重试的记忆窗口（毫秒，24 小时）。
 *
 * 照录 msb-agent `src/payment/idempotency.ts` 实测值：够长以覆盖人工重试，
 * 又不至于让一张凭证永久免单。
 */
export const PAID_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 支付凭证的哈希标识。
 *
 * 凭证本身（`X-PAYMENT` 头）是可重放的签名材料，**只以哈希形式**进内存索引与
 * 错误上下文，绝不原样落日志。
 *
 * @param credential - 请求头里的支付凭证原文
 * @returns 十六进制 SHA-256
 */
export function paymentCredentialId(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

/**
 * 已付款重试键：凭证 + 资源路径 + 请求体三者绑定。
 *
 * 只绑凭证是不够的——那样一张已付凭证就能换任意一次别的检查（越权白嫖）。
 *
 * @param credentialId - {@link paymentCredentialId} 的结果
 * @param path - 请求路径（不含 query）
 * @param requestBody - 请求体原文
 */
export function paymentRetryKey(
  credentialId: string,
  path: string,
  requestBody: string,
): string {
  // 用 0x1f（单元分隔符）分段，避免 "a"+"bc" 与 "ab"+"c" 撞成同一个键。
  return createHash("sha256")
    .update(credentialId, "utf8")
    .update("\x1f", "utf8")
    .update(path, "utf8")
    .update("\x1f", "utf8")
    .update(requestBody, "utf8")
    .digest("hex");
}

/**
 * 已付款重试记忆（内存版，带过期）。
 *
 * 用途：钱已经收了、但服务端随后失败（5xx / facilitator 抛错）时记一笔，
 * 客户拿**同一张凭证**重试时直接放行，不再二次计费。
 *
 * ⚠️ 进程重启即遗忘（照录 msb-agent 的做法）。单实例部署下够用；
 * 真要多实例横向扩，得换成共享存储，那时这个类要整体替换。
 */
export class PaidRetryStore {
  readonly #expiresAtByKey = new Map<string, number>();
  readonly #now: () => number;

  /**
   * @param now - 取当前时间（毫秒）的函数，测试注入假时钟
   */
  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** 该重试键是否在窗口内已被记住（顺带清掉过期项）。 */
  has(retryKey: string): boolean {
    const expiresAt = this.#expiresAtByKey.get(retryKey);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= this.#now()) {
      this.#expiresAtByKey.delete(retryKey);
      return false;
    }
    return true;
  }

  /** 记住一个已付款但服务失败的重试键，窗口 {@link PAID_RETRY_WINDOW_MS}。 */
  remember(retryKey: string): void {
    this.#expiresAtByKey.set(retryKey, this.#now() + PAID_RETRY_WINDOW_MS);
  }

  /** 当前记住的条数，测试断言用。 */
  get size(): number {
    return this.#expiresAtByKey.size;
  }
}
