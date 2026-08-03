import { describe, expect, it } from "vitest";

import { ChainError } from "../errors.js";
import { assertModuleResponse, isModuleId, MODULE_IDS } from "./module-response.js";

const VALID = {
  module: "eu-msb",
  version: "2026.07.1",
  updated_at: "2026-07-01T00:00:00",
  maintainer_wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  royalty_bps: 0,
  checks: [
    {
      id: "c1",
      result: "PASS",
      basis: "caller_assertion",
      reason: "ok",
      source: "https://example.gov",
    },
    {
      id: "c2",
      result: "ESCALATE",
      basis: "manual_review",
      reason: "需人工",
      source: "https://example.gov/2",
    },
  ],
  overall: "ESCALATE",
  settlement_constraints: {
    module: "eu-msb",
    module_version: "2026.07.1",
    deal_id: "case-9",
    valid_until: "2026-08-01T00:00:00",
    blocked_check_ids: [],
    escalated_check_ids: ["c2"],
    evaluated_check_count: 2,
    evidence_hash: "b".repeat(64),
  },
  evidence_hash: "b".repeat(64),
  engine_version: "1.0.0",
  hash_scheme_version: "2",
  disclaimer: "不构成法律意见",
};

describe("assertModuleResponse", () => {
  it("合法响应原样收窄", () => {
    const parsed = assertModuleResponse(VALID);
    expect(parsed.module).toBe("eu-msb");
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.settlement_constraints.escalated_check_ids).toEqual(["c2"]);
  });

  it("NOT_APPLICABLE 是合法状态（上游 2026-07-31 起会返回）", () => {
    const naResponse = {
      ...VALID,
      checks: [
        {
          id: "c1",
          result: "NOT_APPLICABLE",
          basis: "not_applicable",
          reason: "规则条件未触发",
          source: "https://example.gov",
        },
      ],
      overall: "NOT_APPLICABLE",
      settlement_constraints: { ...VALID.settlement_constraints, evaluated_check_count: 0 },
    };
    const parsed = assertModuleResponse(naResponse);
    expect(parsed.overall).toBe("NOT_APPLICABLE");
    expect(parsed.checks[0]?.result).toBe("NOT_APPLICABLE");
    // 无适用检查项时两个阻断列表天然为空，放行与否只能靠 evaluated_check_count。
    expect(parsed.settlement_constraints.evaluated_check_count).toBe(0);
  });

  it("读出 basis / engine_version / hash_scheme_version", () => {
    const parsed = assertModuleResponse(VALID);
    expect(parsed.checks.map((check) => check.basis)).toEqual([
      "caller_assertion",
      "manual_review",
    ]);
    expect(parsed.engine_version).toBe("1.0.0");
    expect(parsed.hash_scheme_version).toBe("2");
  });

  it("basis 取值非法或缺失时点名下标", () => {
    const badValue = { ...VALID, checks: [{ ...VALID.checks[0], basis: "vibes" }] };
    expect(() => assertModuleResponse(badValue)).toThrow(/checks\[0\]\.basis 取值非法：vibes/);

    const withoutBasis: Record<string, unknown> = { ...VALID.checks[0] };
    delete withoutBasis["basis"];
    expect(() => assertModuleResponse({ ...VALID, checks: [withoutBasis] })).toThrow(
      /checks\[0\]\.basis 缺失或不是非空字符串/,
    );
  });

  it("evaluated_check_count 缺失或非非负整数时拒绝", () => {
    const withoutCount: Record<string, unknown> = { ...VALID.settlement_constraints };
    delete withoutCount["evaluated_check_count"];
    expect(() => assertModuleResponse({ ...VALID, settlement_constraints: withoutCount })).toThrow(
      /settlement_constraints\.evaluated_check_count 不是非负整数/,
    );

    for (const bad of [-1, 1.5, "2"]) {
      const response = {
        ...VALID,
        settlement_constraints: { ...VALID.settlement_constraints, evaluated_check_count: bad },
      };
      expect(() => assertModuleResponse(response)).toThrow(
        /settlement_constraints\.evaluated_check_count 不是非负整数/,
      );
    }
  });

  it("engine_version / hash_scheme_version 缺失时点名", () => {
    for (const key of ["engine_version", "hash_scheme_version"]) {
      const response: Record<string, unknown> = { ...VALID };
      delete response[key];
      expect(() => assertModuleResponse(response)).toThrow(
        new RegExp(`${key} 缺失或不是非空字符串`),
      );
    }
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

  it("MODULE_IDS 覆盖五个已上线 Module", () => {
    expect(MODULE_IDS).toEqual(["us-msb", "uk-msb", "eu-msb", "sg-msb", "ae-msb"]);
  });

  it("接受 ae-msb（上游 2026-08 上线的第 5 法域）并原样收窄", () => {
    const aeResponse = {
      ...VALID,
      module: "ae-msb",
      version: "2026.08.1",
      checks: [
        {
          id: "ae-cbuae-rps-license",
          result: "HOLD",
          basis: "missing_evidence",
          reason: "未提供 CBUAE 注册号",
          source: "https://www.centralbank.ae/",
        },
      ],
      overall: "HOLD",
      settlement_constraints: {
        ...VALID.settlement_constraints,
        module: "ae-msb",
        module_version: "2026.08.1",
        blocked_check_ids: ["ae-cbuae-rps-license"],
        escalated_check_ids: [],
        evaluated_check_count: 1,
      },
    };
    const parsed = assertModuleResponse(aeResponse);
    expect(parsed.module).toBe("ae-msb");
    expect(parsed.version).toBe("2026.08.1");
    expect(parsed.settlement_constraints.module).toBe("ae-msb");
    expect(parsed.settlement_constraints.evaluated_check_count).toBe(1);
  });

  it("白名单之外的 module 仍被拒绝，且错误消息点名字段与合法取值", () => {
    // 白名单扩容不等于放松：多一个成员，不是少一道闸。
    expect(() => assertModuleResponse({ ...VALID, module: "za-msb" })).toThrow(
      /^Module 响应字段 module 取值非法：za-msb（应为 us-msb\|uk-msb\|eu-msb\|sg-msb\|ae-msb）$/,
    );
    const badConstraints = {
      ...VALID,
      settlement_constraints: { ...VALID.settlement_constraints, module: "za-msb" },
    };
    expect(() => assertModuleResponse(badConstraints)).toThrow(
      /settlement_constraints\.module 取值非法：za-msb（应为 us-msb\|uk-msb\|eu-msb\|sg-msb\|ae-msb）/,
    );
  });
});

describe("isModuleId", () => {
  it("认已上线的 Module ID", () => {
    for (const id of MODULE_IDS) {
      expect(isModuleId(id)).toBe(true);
    }
    expect(isModuleId("ae-msb")).toBe(true);
  });

  it("不 trim：前后空格一律非法", () => {
    // 这个值会被拼进会真的花钱的 URL，容错等于把错误推迟到付款那一刻。
    expect(isModuleId("ae-msb ")).toBe(false);
    expect(isModuleId(" ae-msb")).toBe(false);
  });

  it("拒绝未上线的 Module ID", () => {
    expect(isModuleId("xx-msb")).toBe(false);
    expect(isModuleId("")).toBe(false);
    expect(isModuleId("AE-MSB")).toBe(false);
  });
});
