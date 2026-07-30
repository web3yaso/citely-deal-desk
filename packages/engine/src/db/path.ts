/**
 * 数据库路径解析 —— **全仓唯一的入口，基准是仓库根，不是 cwd**。
 *
 * ## 为什么这是设计缺陷而不是配置问题
 *
 * `.env` 里写的是 `DB_PATH=./data/deal-desk.sqlite`（相对路径），而这个项目有
 * **多个入口**：`pnpm -F @citely/engine db:reset` 的 cwd 是 `packages/engine/`，
 * `node demo/run-vertical-slice.ts` 的 cwd 是仓库根。相对路径 + 多入口 =
 * 必然分裂成多个库：清库清的是 A，写库写的是 B，**彩排的"从空库冷启动验证幂等"
 * 于是什么都没验证**（2026-07-30 实测：全仓只有 `packages/engine/data/` 一个库，
 * 仓库根下根本没有）。
 *
 * 修法不是"叮嘱大家从根目录运行"，而是**把路径解析收进一个函数、锚在仓库根上**。
 * 谁从哪里运行都得到同一个绝对路径。
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根的标志文件。workspace 清单只可能在根上有一份。 */
const ROOT_MARKER = "pnpm-workspace.yaml";

/** `.env.example` 里的默认值，保持一致。 */
export const DEFAULT_DB_PATH = "./data/deal-desk.sqlite";

/** 找不到仓库根。 */
export class RepoRootNotFoundError extends Error {
  public constructor(from: string) {
    super(`could not locate ${ROOT_MARKER} walking up from ${from}`);
    this.name = "RepoRootNotFoundError";
  }
}

/**
 * 从本模块所在位置向上找仓库根。
 *
 * **刻意不用 `process.cwd()`**——那正是 bug 的来源。本文件的物理位置
 * （`packages/engine/src/db/`）与仓库根的相对关系是固定的，无论谁怎么启动进程。
 *
 * @param from - 起点目录，默认本模块所在目录（仅测试需要覆盖）
 * @throws {RepoRootNotFoundError} 一路向上都没找到标志文件
 */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, ROOT_MARKER))) return current;
    const parent = dirname(current);
    // 到达文件系统根：parent === current。
    if (parent === current) throw new RepoRootNotFoundError(from);
    current = parent;
  }
}

export interface ResolveDbPathOptions {
  /**
   * dry-run 用独立库。
   *
   * dry-run 的语义是"**不发链上交易、不付费**"，不是"不写本地状态"——
   * 状态机与账本本来就是链下的，dry-run 恰恰应该完整演练它们，
   * 否则彩排验的东西和真跑时不是一套。用独立库只是为了不让演练污染真跑的账，
   * 它同样落盘、同样能被 `db:reset` 清掉。
   */
  readonly dryRun?: boolean;
  /** 覆盖仓库根（测试用）。 */
  readonly repoRoot?: string;
}

/** 在扩展名前插入 `.dryrun`：`deal-desk.sqlite` → `deal-desk.dryrun.sqlite`。 */
function toDryRunPath(path: string): string {
  const lastDot = path.lastIndexOf(".");
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // 没有扩展名（或点在目录名里）时直接追加后缀。
  if (lastDot <= lastSep) return `${path}.dryrun`;
  return `${path.slice(0, lastDot)}.dryrun${path.slice(lastDot)}`;
}

/**
 * 解析出**绝对**数据库路径。
 *
 * - `DB_PATH` 已是绝对路径 → 原样使用；
 * - 相对路径（含缺省值）→ **相对仓库根**解析，与 cwd 无关；
 * - `dryRun` → 同目录下的 `*.dryrun.sqlite`。
 *
 * @param env - 环境变量（默认 `process.env`）
 * @param options - dry-run 与仓库根覆盖
 * @returns 绝对路径
 */
export function resolveDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: ResolveDbPathOptions = {},
): string {
  const raw = env["DB_PATH"];
  const configured = raw === undefined || raw.trim() === "" ? DEFAULT_DB_PATH : raw.trim();
  const root = options.repoRoot ?? findRepoRoot();
  const absolute = isAbsolute(configured) ? configured : resolve(root, configured);
  return options.dryRun === true ? toDryRunPath(absolute) : absolute;
}

/**
 * 本项目会用到的**全部**数据库路径（真跑 + dry-run）。
 *
 * `db:reset` 按这个清单清库——漏掉任何一个，"从空库冷启动"就又是假的。
 */
export function knownDbPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Pick<ResolveDbPathOptions, "repoRoot"> = {},
): readonly string[] {
  return [
    resolveDbPath(env, { ...options, dryRun: false }),
    resolveDbPath(env, { ...options, dryRun: true }),
  ];
}
