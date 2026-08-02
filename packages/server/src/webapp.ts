/**
 * 演示 UI 的静态文件——与 agent-icon 同一纪律：**模块加载时同步读入**。
 *
 * 不用 serveStatic：它的 root 是相对进程 cwd 解析的，本仓库经 tsx 从不同目录
 * 启动（本地 repo 根、Railway 的 packages/server），cwd 不可靠。按
 * `import.meta.url` 读死三个文件，"文件没随部署带上去"在启动时就炸，
 * 而不是等人打开页面才 404。
 */

import { readFileSync } from "node:fs";

export interface WebappFile {
  readonly body: string;
  readonly contentType: string;
}

function load(name: string, contentType: string): WebappFile {
  return {
    body: readFileSync(new URL(`./webapp/${name}`, import.meta.url), "utf8"),
    contentType,
  };
}

/** 路由路径 → 文件。三个都在这里，路由层不再碰文件系统。 */
export const WEBAPP_FILES: ReadonlyMap<string, WebappFile> = new Map([
  ["/app", load("index.html", "text/html; charset=utf-8")],
  ["/app/app.js", load("app.js", "text/javascript; charset=utf-8")],
  ["/app/style.css", load("style.css", "text/css; charset=utf-8")],
]);
