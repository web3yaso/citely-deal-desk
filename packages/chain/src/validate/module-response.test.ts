import { describe, expect, it } from "vitest";

import { ChainError } from "../errors.js";
import { assertModuleResponse, MODULE_IDS } from "./module-response.js";

const VALID = {
  module: "eu-msb",
  version: "2026.07.1",
  updated_at: "2026-07-01T00:00:00",
  maintainer_wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  royalty_bps: 0,
  checks: [
    { id: "c1", result: "PASS", reason: "ok", source: "https://example.gov" },
    { id: "c2", result: "ESCALATE", reason: "需人工", source: "https://example.gov/2" },
  ],
  overall: "ESCALATE",
  settlement_constraints: {
    module: "eu-msb",
    module_version: "2026.07.1",
    deal_id: "case-9",
    valid_until: "2026-08-01T00:00:00",
    blocked_check_ids: [],
    escalated_check_ids: ["c2"],
    evidence_hash: "b".repeat(64),
  },
  evidence_hash: "b".repeat(64),
  disclaimer: "不构成法律意见",
};

describe("assertModuleResponse", () => {
  it("合法响应原样收窄", () => {
    const parsed = assertModuleResponse(VALID);
    expect(parsed.module).toBe("eu-msb");
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.settlement_constraints.escalated_check_ids).toEqual(["c2"]);
  });

  it("非对象直接拒绝", () => {
    expect(() => assertModuleResponse("nope")).toThrow(ChainError);
    expect(() => assertModuleResponse(null)).toThrow(/\(root\) 不是对象/);
    expect(() => assertModuleResponse([VALID])).toThrow(/\(root\) 不是对象/);
  });

  it("checks 为空数组时拒绝", () => {
    expect(() => assertModuleResponse({ ...VALID, checks: [] })).toThrow(/checks 缺失或为空数组/);
  });

  it("check 项状态非法时点名下标", () => {
    const bad = { ...VALID, checks: [{ ...VALID.checks[0], result: "OK" }] };
    expect(() => assertModuleResponse(bad)).toThrow(/checks\[0\]\.result 取值非法：OK/);
  });

  it("evidence_hash 必须是 64 位小写十六进制且无 0x", () => {
    expect(() => assertModuleResponse({ ...VALID, evidence_hash: `0x${"b".repeat(64)}` })).toThrow(
      /evidence_hash 不是 64 位小写十六进制/,
    );
    expect(() => assertModuleResponse({ ...VALID, evidence_hash: "B".repeat(64) })).toThrow(
      /evidence_hash 不是 64 位小写十六进制/,
    );
  });

  it("royalty_bps 越界或非整数时拒绝", () => {
    expect(() => assertModuleResponse({ ...VALID, royalty_bps: 10_001 })).toThrow(
      /royalty_bps 不是 0–10000 的整数/,
    );
    expect(() => assertModuleResponse({ ...VALID, royalty_bps: 1.5 })).toThrow(/royalty_bps/);
    expect(() => assertModuleResponse({ ...VALID, royalty_bps: "500" })).toThrow(/royalty_bps/);
  });

  it("maintainer_wallet 非地址时拒绝", () => {
    expect(() => assertModuleResponse({ ...VALID, maintainer_wallet: "0xdead" })).toThrow(
      /maintainer_wallet 不是合法 EVM 地址/,
    );
  });

  it("settlement_constraints 缺失时点名", () => {
    const withoutConstraints: Record<string, unknown> = { ...VALID };
    delete withoutConstraints["settlement_constraints"];
    expect(() => assertModuleResponse(withoutConstraints)).toThrow(
      /settlement_constraints 不是对象/,
    );
  });

  it("blocked_check_ids 不是字符串数组时拒绝", () => {
    const bad = {
      ...VALID,
      settlement_constraints: { ...VALID.settlement_constraints, blocked_check_ids: [1] },
    };
    expect(() => assertModuleResponse(bad)).toThrow(
      /settlement_constraints\.blocked_check_ids 不是字符串数组/,
    );
  });

  it("MODULE_IDS 覆盖四个已上线 Module", () => {
    expect(MODULE_IDS).toEqual(["us-msb", "uk-msb", "eu-msb", "sg-msb"]);
  });
});
