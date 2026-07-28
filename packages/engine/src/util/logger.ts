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

/** 已知密钥形状：OpenAI key、0x 私钥、Bearer 头。命中即整体替换。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b0x[0-9a-fA-F]{64}\b/g,
  /(?<=[Bb]earer\s)[A-Za-z0-9._-]{16,}/g,
];

/** 把疑似密钥替换成 `[REDACTED]`。这是兜底，不是"可以随便打日志"的许可。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
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
