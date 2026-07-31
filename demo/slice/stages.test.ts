/**
 * 本文件只守一件事：`@citely/demo/slice/stages` 这个**导入路径**还活着。
 *
 * 阶段函数的行为由 `packages/engine/src/orchestrator/stages.test.ts` 覆盖——
 * 在这里再断言一遍行为，就等于把"只剩一份实现"重新变成"两份说法"。
 */

import { intake as engineIntake } from "@citely/engine/orchestrator";
import { describe, expect, it } from "vitest";

import { CLEAN_DEAL_INPUT } from "../fixtures/index.js";
import { intake } from "./stages.js";

describe("slice/stages 转发入口", () => {
  it("转发的就是 engine 那一份实现，不是副本", () => {
    expect(intake).toBe(engineIntake);
  });

  it("engine 脚本依赖的 intake 仍可用", () => {
    const facts = intake(CLEAN_DEAL_INPUT);
    expect(facts.material_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
