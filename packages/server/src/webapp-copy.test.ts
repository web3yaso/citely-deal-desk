/**
 * 演示 UI 的**措辞红线**静态断言。
 *
 * webapp 三件套是全局 `<script>`、无构建步骤，没法 import 进 vitest 跑 DOM
 * 断言（为可测性把产品源改成模块，收益小于侵入——见设计 §8.2）。因此这一层
 * 守的不是渲染行为，而是**对外一句话都不能改错**：免责声明原句、SA 的"证明
 * 不是指令"口径、四拍与链上事件名齐备、以及一组绝不允许出现的禁语。
 *
 * 故意插一句 `Citely authorizes the payment` 进 app.js，本文件必须转红。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function webappFile(name: string): string {
  return readFileSync(new URL(`./webapp/${name}`, import.meta.url), "utf8");
}

const INDEX_HTML = webappFile("index.html");
const APP_JS = webappFile("app.js");

/** 与 `constants.ts` 的 DISCLAIMER 同一句，页脚一字不动。 */
const DISCLAIMER =
  "Results are compliance check statuses compiled from public legal sources. Not legal advice.";

/**
 * 禁语。大小写不敏感，两个静态文件都查。
 *
 * 它们全都指向同一条不变量：我们出的是**检查项状态 + 三项确定性检查**，
 * 既不是法律结论，也不是"Citely 批准了这笔付款"。
 */
const FORBIDDEN = [
  "authorizes the payment",
  "Citely authorizes",
  "Citely approves",
  "legally compliant",
  "is compliant",
  "legal opinion",
];

describe("演示 UI 的措辞红线", () => {
  it("footer 免责声明原句在 index.html 里，一字不差", () => {
    expect(INDEX_HTML).toContain(DISCLAIMER);
  });

  it("四拍标签齐备", () => {
    for (const label of ["Job created", "Escrow funded", "Work submitted", "Verified & completed"]) {
      expect(APP_JS).toContain(label);
    }
  });

  it("四个链上事件名齐备（叙事与 ABI 一一对应）", () => {
    for (const event of ["JobCreated", "JobFunded", "JobSubmitted", "JobCompleted"]) {
      expect(APP_JS).toContain(event);
    }
  });

  it("终局的三个替代形态都在，绝不是一律显示 Verified", () => {
    expect(APP_JS).toContain("Rejected — escrow refunded to your wallet");
    expect(APP_JS).toContain("Expired — refund claimable / claimed by the client");
    expect(APP_JS).toContain("Awaiting evaluator");
    expect(APP_JS).toContain("Verification failed —");
  });

  it.each(FORBIDDEN)("禁语 %j 不出现在任何静态文件里", (phrase) => {
    const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    expect(APP_JS).not.toMatch(pattern);
    // 免责声明原句里有 "Not legal advice."，但没有任何一条禁语——原句照查不误。
    expect(INDEX_HTML).not.toMatch(pattern);
  });

  it("SA 口径原句保留：证明，不是指令", () => {
    expect(APP_JS).toContain("The SA is proof, not an instruction");
  });

  it("setBudget 的 provider-only 事实仍然明示", () => {
    expect(APP_JS).toContain("provider-only");
    expect(APP_JS).toMatch(/chain restricts (that step|to) /i);
  });

  it("hero 的两句限定语在位：不是法律结论、链上只有哈希", () => {
    expect(APP_JS).toContain("Three deterministic checks on the deliverable — not a legal conclusion.");
    expect(APP_JS).toContain("Hashes only; the SA document itself stays off-chain.");
    expect(APP_JS).toContain("hash only, the SA document stays off-chain");
  });

  it("Model verdicts 的「LLM 无权改判定」小字未被删", () => {
    expect(APP_JS).toContain("Model verdicts (cannot move money)");
    expect(APP_JS).toContain("the policy engine's type signature cannot even receive these verdicts");
  });

  it("链读失败的降级措辞在位（不允许推测性显示）", () => {
    expect(APP_JS).toContain("on-chain state unavailable");
  });

  it("每个签名明细行都带签署者标签", () => {
    expect(APP_JS).toContain("your wallet");
    expect(APP_JS).toContain('who: "citely"');
    expect(APP_JS).toContain('who: "agent"');
  });
});
