import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DB_PATH,
  findRepoRoot,
  knownDbPaths,
  RepoRootNotFoundError,
  resolveDbPath,
} from "./path.js";

const ROOT = findRepoRoot();

describe("findRepoRoot", () => {
  it("找到含 pnpm-workspace.yaml 的目录", () => {
    expect(existsSync(join(ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("**不依赖 cwd**：从任意起点向上找都得到同一个根", () => {
    expect(findRepoRoot(join(ROOT, "packages", "engine", "src", "db"))).toBe(ROOT);
    expect(findRepoRoot(join(ROOT, "packages", "chain", "src"))).toBe(ROOT);
    expect(findRepoRoot(ROOT)).toBe(ROOT);
  });

  it("找不到标志文件时报错，不返回一个瞎猜的路径", () => {
    expect(() => findRepoRoot("/")).toThrow(RepoRootNotFoundError);
  });
});

describe("resolveDbPath —— 相对路径锚在仓库根，与 cwd 无关", () => {
  it("缺省值解析到 <root>/data/deal-desk.sqlite", () => {
    expect(resolveDbPath({})).toBe(join(ROOT, "data", "deal-desk.sqlite"));
    expect(DEFAULT_DB_PATH).toBe("./data/deal-desk.sqlite");
  });

  it("空串按缺省处理", () => {
    expect(resolveDbPath({ DB_PATH: "   " })).toBe(resolveDbPath({}));
  });

  it("**2026-07-30 事故回归**：不论从哪个子目录运行，都得到同一个绝对路径", () => {
    const fromEngine = resolveDbPath({}, { repoRoot: findRepoRoot(join(ROOT, "packages", "engine")) });
    const fromDemo = resolveDbPath({}, { repoRoot: findRepoRoot(join(ROOT, "demo")) });
    expect(fromEngine).toBe(fromDemo);
    // 曾经的错误结果：packages/engine/data/deal-desk.sqlite
    expect(fromEngine).not.toContain(join("packages", "engine", "data"));
  });

  it("绝对路径原样使用", () => {
    expect(resolveDbPath({ DB_PATH: "/tmp/x/y.sqlite" })).toBe("/tmp/x/y.sqlite");
  });

  it("相对路径按仓库根解析，不是按 cwd", () => {
    expect(resolveDbPath({ DB_PATH: "./var/db.sqlite" })).toBe(join(ROOT, "var", "db.sqlite"));
    expect(resolveDbPath({ DB_PATH: "var/db.sqlite" })).toBe(join(ROOT, "var", "db.sqlite"));
  });

  it("返回值恒为绝对路径", () => {
    for (const value of [undefined, "./a.sqlite", "a/b.sqlite", "/abs/c.sqlite"]) {
      const resolved = resolveDbPath(value === undefined ? {} : { DB_PATH: value });
      expect(resolved.startsWith("/")).toBe(true);
    }
  });
});

describe("dry-run 独立库（落盘，且能被 db:reset 清掉）", () => {
  it("在扩展名前插入 .dryrun", () => {
    expect(resolveDbPath({}, { dryRun: true })).toBe(
      join(ROOT, "data", "deal-desk.dryrun.sqlite"),
    );
  });

  it("与真跑库在同一目录、互不覆盖", () => {
    const real = resolveDbPath({}, { dryRun: false });
    const dry = resolveDbPath({}, { dryRun: true });
    expect(dry).not.toBe(real);
    expect(dry.startsWith(join(ROOT, "data"))).toBe(true);
  });

  it("无扩展名时追加后缀", () => {
    expect(resolveDbPath({ DB_PATH: "/tmp/dbfile" }, { dryRun: true })).toBe("/tmp/dbfile.dryrun");
  });

  it("目录名里含点也不会认错扩展名", () => {
    expect(resolveDbPath({ DB_PATH: "/tmp/v1.2/db" }, { dryRun: true })).toBe("/tmp/v1.2/db.dryrun");
  });
});

describe("knownDbPaths —— db:reset 的清库清单", () => {
  it("真跑库与 dry-run 库都在清单里（漏一个，冷启动就是假的）", () => {
    const paths = knownDbPaths({});
    expect(paths).toEqual([resolveDbPath({}), resolveDbPath({}, { dryRun: true })]);
    expect(new Set(paths).size).toBe(2);
  });
});
