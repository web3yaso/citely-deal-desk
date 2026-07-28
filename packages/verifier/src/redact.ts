/**
 * 密钥遮蔽兜底。
 *
 * 验证器进程本身不把私钥放进任何错误消息，但第三方库（viem/RPC 传输层）
 * 可能把入参回显进异常。对外抛出/打印前一律过这里。
 *
 * NOTE: chain 包也会导出同名工具（合约 §9）。等 chain 落地后由主导广播合并，
 * 届时本文件改为 re-export，避免两份实现漂移。
 */

/**
 * 已知密钥形状：0x 私钥、OpenAI key、Bearer 头。命中即整体替换。
 *
 * 注意 `0x` + 64 hex 与 txHash / bytes32 哈希同形，所以本函数**只用在错误路径**，
 * 不要拿去过正常状态输出——否则 txHash 会被打成 `[REDACTED]`，演示无法核对链上。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b0x[0-9a-fA-F]{64}\b/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?<=[Bb]earer\s)[A-Za-z0-9._-]{16,}/g,
];

/**
 * 把疑似密钥替换成 `[REDACTED]`。
 *
 * @param text - 待遮蔽文本
 * @returns 遮蔽后的文本
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * 从任意异常提取可安全外泄的消息。
 *
 * @param err - 捕获到的异常
 * @returns 已遮蔽的错误描述
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactSecrets(raw);
}
