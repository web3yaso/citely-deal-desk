/**
 * 验证器服务进程入口（Railway 第二个服务的 `start` 脚本指向本文件）。
 *
 * 这个进程**只持有 `VERIFIER_PRIVATE_KEY`**：另外四把钥匙与 `OPENAI_API_KEY`
 * 在它的环境里根本不存在（合约 §8 密钥纪律）。它不判定、不采购、不签 SA，
 * 只做三件事：跑三检、按结论收口（complete / reject）、如实回报。
 *
 * ⚠️ 当前**尚未打通**：`@citely/chain` 的 `createJobClient` 要求
 * `JobRoleWallets` 三把钱包齐全（client / provider / evaluator），
 * 而本进程按纪律只该有 evaluator 一把。在 chain 把另外两把改成可选之前，
 * 本入口**拒绝启动**而不是拿假钱包凑数——凑出来的"独立验证器"是假的。
 */

import { loadDotEnvFile, redactSecrets, safeErrorMessage } from "@citely/chain";
import { createLogger, findRepoRoot } from "@citely/engine";
import { join } from "node:path";

import { loadVerifierServiceConfig, ServerConfigError } from "./config.js";

const log = createLogger("verifier-server");

function main(): void {
  // 本地开发从仓库根 `.env` 取值；Railway 上由平台注入（文件缺失是静默的，
  // 且不覆盖已有环境变量）。**验证器服务的 .env 只该有它自己那把钥匙。**
  loadDotEnvFile(join(findRepoRoot(), ".env"));
  // 先读配置：即使下面必然中止，配置错误也该被优先报出来（部署时先修配置）。
  loadVerifierServiceConfig();

  throw new ServerConfigError(
    "验证器独立服务尚未打通：@citely/chain 的 JobRoleWallets 要求 client / provider / " +
      "evaluator 三把钱包齐全，而本进程按密钥纪律只持有 VERIFIER_PRIVATE_KEY。" +
      "需要 chain 把 client / provider 改为可选（调用对应写方法时才要求），" +
      "本入口即可接上 verifier-app.ts（其三检与收口逻辑已完成且有测试覆盖）。",
  );
}

try {
  main();
} catch (error: unknown) {
  log.error("verifier server aborted", { error: safeErrorMessage(error) });
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\n✗ 验证器服务启动中止：${redactSecrets(detail)}\n`);
  process.exitCode = 1;
}
