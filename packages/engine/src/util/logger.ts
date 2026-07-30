/**
 * 极简结构化 logger（engine 内唯一日志出口，禁止 `console.log`）。
 *
 * 纪律：
 * - **材料内容永不进日志**，只记 `material_sha256` / `excerpt_sha256` 之类的摘要；
 * - **任何密钥永不进日志**：`redactSecrets()` 对已知密钥形状做兜底遮蔽；
 * - 输出走 stderr，避免污染 stdout（demo 脚本可能把 stdout 当数据通道）。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 按**形状**识别的密钥：OpenAI key 与 Bearer 头。两者的形状都不与其它数据撞车。
 *
 * ⚠️ 曾经这里还有一条 `\b0x[0-9a-fA-F]{64}\b`（"看起来像私钥"）。**已删除**，
 * 因为 0x + 64 位十六进制同时也是 `sa_hash` / `txHash` / `evidence_hash` /
 * `deliverableHash` 的形状——那条规则把**每一个哈希**都打成 `[REDACTED]`，
 * 而这些哈希正是对账与"可复算"叙事要给人看的东西（2026-07-29 主导跑幂等实证时
 * 就被它挡住了，看不到 sa_hash）。
 *
 * 私钥与哈希在形状上不可区分，所以改用**显式登记**：真正持有密钥的代码调
 * {@link registerSecret} 登记那个值，之后它在任何日志里都会被遮蔽。
 * engine 按密钥纪律**本来就不持有任何链上私钥**（SA 签名收的是已构造好的
 * `LocalAccount`，不是裸私钥），所以靠形状猜测这件事对我们零收益、纯损失。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?<=[Bb]earer\s)[A-Za-z0-9._-]{16,}/g,
];

/** 显式登记的密钥值。用 Set 而不是数组：同一个值登记多次没有意义。 */
const registeredSecrets = new Set<string>();

/**
 * 登记一个必须被遮蔽的密钥值。
 *
 * 给"确实持有密钥"的代码用（engine 目前没有这样的代码，接口留给将来）。
 * 太短的值不登记——遮蔽一个两三字符的串会把正常文本打成筛子。
 *
 * @param secret - 密钥明文；短于 8 字符者忽略
 */
export function registerSecret(secret: string): void {
  if (secret.trim().length >= 8) registeredSecrets.add(secret.trim());
}

/** 清空登记表（测试用）。 */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** 正则元字符转义，供登记值做字面量替换。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把已知密钥替换成 `[REDACTED]`。这是兜底，不是"可以随便打日志"的许可。
 *
 * **不遮蔽哈希**——哈希是要给人对账的。材料内容仍然一律不进日志
 * （只记 `material_sha256`），那条纪律靠调用点自觉，不靠这个函数。
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  for (const secret of registeredSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  return out;
}

function currentLevel(): LogLevel {
  const raw = process.env["LOG_LEVEL"];
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

function emit(
  scope: string,
  level: LogLevel,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(fields ?? {}),
  });
  process.stderr.write(`${redactSecrets(line)}\n`);
}

/** 建一个带作用域前缀的 logger，如 `createLogger("adjudicator")`。 */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => {
      emit(scope, "debug", m, f);
    },
    info: (m, f) => {
      emit(scope, "info", m, f);
    },
    warn: (m, f) => {
      emit(scope, "warn", m, f);
    },
    error: (m, f) => {
      emit(scope, "error", m, f);
    },
  };
}
