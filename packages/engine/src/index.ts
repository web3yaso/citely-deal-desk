/**
 * `@citely/engine` 的总入口。
 *
 * 依赖方向（合约 §5.0，线性不成环）：`chain ← engine ← verifier`。
 * **engine 绝不许 import `@citely/verifier`。**
 *
 * 判定器**刻意不在这个 barrel 里**（要用请 `import "@citely/engine/adjudicator"`）：
 * 它会把 `openai` SDK 拉进任何 import 本模块的进程，而验证器进程按密钥纪律
 * 根本不该持有 `OPENAI_API_KEY`，三检也是纯确定性检查、不需要 LLM（合约 §8）。
 */

export * from "./sa/index.js";
export * from "./policy/index.js";
export * from "./sandbox/index.js";
export * from "./rubric/index.js";
export * from "./db/index.js";
export * from "./ledger/index.js";
export { canonicalBytes, canonicalJson, CanonicalJsonError } from "./util/canonical.js";
export { sha256Canonical, sha256Hex, sha256Hex0x } from "./util/hash.js";
export { createLogger, redactSecrets } from "./util/logger.js";
export type { Logger, LogLevel } from "./util/logger.js";
