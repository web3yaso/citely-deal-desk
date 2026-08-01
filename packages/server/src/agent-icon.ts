/**
 * agent 图标字节。card 的 `image` 指向它，8004 索引与钱包会来抓这张图。
 *
 * **在模块加载时同步读入，不在请求里读盘**：这张图每个请求都一样，
 * 而且启动即读能让"文件没随部署带上去"在**启动时**就炸，
 * 而不是等某个索引来抓图时才 500——那种失败没人会看见。
 *
 * 路径基于 `import.meta.url` 解析，因此本仓库以 tsx 直跑 `src/` 时天然可用；
 * 若将来引入构建产物目录，必须把 `src/static/` 一并拷进去。
 */

import { readFileSync } from "node:fs";

/**
 * PNG 字节，`ArrayBuffer` 形态——hono `body()` 的类型只收 ArrayBuffer / 流 / 字符串。
 *
 * 先 `new Uint8Array(...)` 再取 `.buffer`：`readFileSync` 返回的 Buffer 可能坐落在
 * Node 的**共享内存池**上，直接取它的 `.buffer` 会把整块池子（连同别人的数据）发出去。
 * 这一层构造是拷贝，拿到的是一块恰好这么大的独立内存。
 */
export const AGENT_ICON_BYTES: ArrayBuffer = new Uint8Array(
  readFileSync(new URL("./static/agent-icon.png", import.meta.url)),
).buffer;

export const AGENT_ICON_CONTENT_TYPE = "image/png";
