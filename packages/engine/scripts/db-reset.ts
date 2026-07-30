/**
 * 彩排冷启动：清空本地状态库（《模块拆分》§三 D6"每次从空数据库冷启动验证幂等"）。
 *
 * 跑法（**从哪个目录跑都一样**——路径锚在仓库根，不是 cwd）：
 * ```
 * pnpm -F @citely/engine db:reset
 * DB_PATH=/abs/path/other.sqlite pnpm -F @citely/engine db:reset
 * ```
 *
 * 它清**全部**已知库（真跑库 + dry-run 库），并打印每个库的**绝对路径**与被删的表。
 * 打印绝对路径不是装饰：2026-07-30 的事故就是"清的是 `packages/engine/data/`、
 * 写的是别处"，而路径全程不可见，于是彩排的核心验证项形同虚设了一整天。
 *
 * 只删表再重建，不碰 `.env`、不碰密钥、零网络。
 */

import { fileURLToPath } from "node:url";

import { loadDotEnvFile } from "@citely/chain";

import { findRepoRoot, knownDbPaths } from "../src/db/path.js";
import { resetDatabase, SCHEMA_VERSION } from "../src/db/schema.js";
import { createLogger } from "../src/util/logger.js";

const log = createLogger("db-reset");

function main(): void {
  // 脚本自己加载 .env，且用仓库根定位它——不依赖 cwd。
  const repoRoot = findRepoRoot();
  loadDotEnvFile(fileURLToPath(new URL(`file://${repoRoot}/.env`)));

  const paths = knownDbPaths(process.env, { repoRoot });
  let totalDropped = 0;

  for (const dbPath of paths) {
    const dropped = resetDatabase(dbPath);
    totalDropped += dropped.length;
    log.info("reset", {
      // 绝对路径，一眼可核对——这次的问题就是路径不可见造成的。
      db_path: dbPath,
      schema_version: SCHEMA_VERSION,
      dropped_tables: dropped,
      dropped_count: dropped.length,
    });
  }

  log.info("cold start ready", {
    repo_root: repoRoot,
    databases: paths.length,
    tables_dropped: totalDropped,
  });
  if (totalDropped === 0) {
    log.info("all databases were already empty (fresh clone or first run)");
  }
}

try {
  main();
} catch (err: unknown) {
  log.error("db reset failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
}
