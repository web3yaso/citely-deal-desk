/**
 * 对外文案一律英文——**静态扫描源码**，不是抽查某个响应。
 *
 * 为什么要静态扫：这批中文是分三轮才清干净的。
 * 第一轮改了 app.ts 的 5 条，第二轮才发现字段级校验消息也是中文，
 * 第三轮又发现模板串（`` `请求体不得超过 ${n}KB` ``）和 rate-limit / verifier-app
 * 被前两次的 grep 漏掉了——因为前两次只匹配双引号。
 *
 * 逐个响应写断言永远追不上新增的分支；扫源码能覆盖**还没被任何测试走到的**那些。
 *
 * 注释、测试名、JSDoc 随便写中文——这里只管**会进 HTTP 响应体的字符串字面量**，
 * 判据是它出现在 `message:` 后面。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** 会把字符串发给调用方的文件。新增对外端点时把文件加进来。 */
const PUBLIC_SURFACE = [
  "app.ts",
  "deal-input.ts",
  "case-request.ts",
  "rate-limit.ts",
  "verifier-app.ts",
  "agent-card.ts",
  "constants.ts",
] as const;

/** CJK 统一表意文字。够覆盖中文，且不会误伤英文标点。 */
const CJK = /[一-鿿]/;

/** `message: "…"` 或 `` message: `…` ``，取值那一段。 */
const MESSAGE_LITERAL = /message:\s*(["`])((?:\\.|(?!\1).)*)\1/gu;

/** 与本测试同目录，直接按 `import.meta.url` 解析——不依赖进程 cwd。 */
function readSource(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

describe("对外文案一律英文", () => {
  it.each(PUBLIC_SURFACE)("%s 的 message 字面量不含中文", (file) => {
    const offenders: string[] = [];
    for (const match of readSource(file).matchAll(MESSAGE_LITERAL)) {
      const value = match[2] ?? "";
      if (CJK.test(value)) offenders.push(value);
    }
    expect(offenders).toEqual([]);
  });

  // 守卫自身也要能红：正则写坏了（比如漏了反引号分支）这条会立刻发现。
  it("扫描逻辑本身认得出中文 message —— 含双引号与模板串两种写法", () => {
    const sample = 'message: "必须是对象"\nmessage: `参与方不得超过 ${n} 个`\nmessage: "ok"';
    const found = [...sample.matchAll(MESSAGE_LITERAL)]
      .map((m) => m[2] ?? "")
      .filter((v) => CJK.test(v));
    expect(found).toHaveLength(2);
  });
});
