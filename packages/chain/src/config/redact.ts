/**
 * 全局登记的密钥。
 *
 * 「所有对外抛出的错误都要过 redact」这条纪律不能靠每个 catch 块自觉传参——
 * 漏一处就泄一次。因此 {@link createChainClients} 等入口在拿到私钥时立即登记，
 * 之后任何一次 {@link redactSecrets} 调用都会自动带上它们。
 */
const registeredSecrets = new Set<string>();

/**
 * 登记一个需要在所有错误消息中屏蔽的密钥。重复登记无副作用。
 *
 * @param secret - 私钥等敏感串；`undefined`/空串会被忽略
 */
export function registerSecret(secret: string | undefined): void {
  if (secret !== undefined && secret !== "") {
    registeredSecrets.add(secret);
  }
}

/** 清空全局登记表。**仅供测试**在用例之间隔离状态。 */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/**
 * 把消息里出现的密钥替换为 `[REDACTED]`。
 *
 * viem 在 RPC 报错里会回显整段请求（可能含签名原文），日志与异常一律先过这里。
 * 参考 msb-agent `scripts/smoke-shared.ts` 的 `getSafeErrorMessage`：
 * 私钥可能以带 `0x` 与不带 `0x` 两种写法出现，两种变体都要替换。
 *
 * @param message - 原始消息
 * @param secrets - 额外要屏蔽的密钥；全局登记的密钥总是一并屏蔽
 * @returns 屏蔽后的消息
 */
export function redactSecrets(
  message: string,
  ...secrets: readonly (string | undefined)[]
): string {
  return [...secrets, ...registeredSecrets].reduce<string>((safe, secret) => {
    if (secret === undefined || secret === "") {
      return safe;
    }
    // 先替长的（带 0x 的那个），否则短变体会先命中、留下一个孤立的 "0x" 前缀。
    const variants = secret.startsWith("0x")
      ? [secret, secret.slice(2)]
      : [`0x${secret}`, secret];
    return variants.reduce((acc, variant) => acc.replaceAll(variant, "[REDACTED]"), safe);
  }, message);
}

/**
 * 从任意 `unknown` 抛出物提取消息并屏蔽密钥。catch 块里统一用它。
 *
 * @param error - catch 到的值
 * @param secrets - 需要屏蔽的密钥
 */
export function safeErrorMessage(
  error: unknown,
  ...secrets: readonly (string | undefined)[]
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, ...secrets);
}
