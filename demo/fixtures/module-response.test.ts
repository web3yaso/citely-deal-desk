import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertModuleResponse } from "@citely/chain";
import { describe, expect, it } from "vitest";

import {
  assertRoyaltyRenderable,
  loadModuleResponse,
  MODULE_RESPONSE_PROVENANCE,
  RECORDING_PATH,
  RecordingError,
  SYNTHETIC_MODULE_RESPONSE,
  UnrecordedRoyaltyError,
} from "./module-response.js";

describe("loadModuleResponse", () => {
  it("没有录制时退回合成替身，且版税闸仍然挡着", () => {
    const { provenance, response } = loadModuleResponse();
    if (provenance.source === "synthetic") {
      expect(response).toEqual(SYNTHETIC_MODULE_RESPONSE);
      expect(provenance.royaltyRecorded).toBe(false);
      expect(() => assertRoyaltyRenderable(provenance)).toThrow(UnrecordedRoyaltyError);
    } else {
      // 已录制：闸放行，且版税字段来自真实响应。
      expect(provenance.royaltyRecorded).toBe(true);
      expect(() => assertRoyaltyRenderable(provenance)).not.toThrow();
    }
  });

  it("录制路径落在 fixtures/recorded/ 下", () => {
    expect(RECORDING_PATH).toContain(join("fixtures", "recorded"));
    expect(RECORDING_PATH.endsWith("us-msb.json")).toBe(true);
  });

  it("合成替身的来源标注与响应内容一致", () => {
    expect(MODULE_RESPONSE_PROVENANCE.module).toBe(SYNTHETIC_MODULE_RESPONSE.module);
    expect(MODULE_RESPONSE_PROVENANCE.version).toBe(SYNTHETIC_MODULE_RESPONSE.version);
  });
});

describe("合成替身与新引擎语义一致（2026-07-31 破坏性变更）", () => {
  it("能过 chain 的校验器（新增字段一个都不缺）", () => {
    // 少一个 basis / evaluated_check_count 就会在这里炸，而不是等到演示当天。
    const raw: unknown = JSON.parse(JSON.stringify(SYNTHETIC_MODULE_RESPONSE));
    expect(() => assertModuleResponse(raw)).not.toThrow();
  });

  it("至少有一条 NOT_APPLICABLE——否则又退回「全 PASS」那种失真形态", () => {
    const notApplicable = SYNTHETIC_MODULE_RESPONSE.checks.filter(
      (check) => check.result === "NOT_APPLICABLE",
    );
    expect(notApplicable.length).toBeGreaterThan(0);
  });

  it("NOT_APPLICABLE 与 basis=not_applicable 严格互为充要", () => {
    for (const check of SYNTHETIC_MODULE_RESPONSE.checks) {
      expect(check.basis === "not_applicable").toBe(check.result === "NOT_APPLICABLE");
    }
  });

  it("非空材料只能记为 caller_assertion——上游没连任何注册/许可库", () => {
    // 出现"已核验"口径的 basis 就说明替身在冒充上游没有的能力。
    const asserted = SYNTHETIC_MODULE_RESPONSE.checks.filter(
      (check) => check.basis === "caller_assertion",
    );
    expect(asserted.length).toBeGreaterThan(0);
  });

  it("evaluated_check_count 等于非 NOT_APPLICABLE 的条数", () => {
    // 这个数是放行判据的一部分，填错等于让 dry-run 骗过真实结算逻辑。
    const evaluated = SYNTHETIC_MODULE_RESPONSE.checks.filter(
      (check) => check.result !== "NOT_APPLICABLE",
    ).length;
    expect(SYNTHETIC_MODULE_RESPONSE.settlement_constraints.evaluated_check_count).toBe(
      evaluated,
    );
  });

  it("满足收紧后的放行判据（三条同时成立）", () => {
    const c = SYNTHETIC_MODULE_RESPONSE.settlement_constraints;
    expect(c.blocked_check_ids).toEqual([]);
    expect(c.escalated_check_ids).toEqual([]);
    expect(c.evaluated_check_count).toBeGreaterThan(0);
  });

  it("带上引擎与哈希方案版本，且哈希是 scheme 2 之后不可复算的占位值", () => {
    expect(SYNTHETIC_MODULE_RESPONSE.engine_version).toBe("1.0.0");
    expect(SYNTHETIC_MODULE_RESPONSE.hash_scheme_version).toBe("2");
    // 显眼的 aaaa… 是刻意的：别让人以为它能离线复算。
    expect(SYNTHETIC_MODULE_RESPONSE.evidence_hash).toBe("a".repeat(64));
    expect(SYNTHETIC_MODULE_RESPONSE.settlement_constraints.evidence_hash).toBe(
      SYNTHETIC_MODULE_RESPONSE.evidence_hash,
    );
  });
});

describe("录制文件校验（坏数据不许静默降级）", () => {
  function writeRecording(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "citely-rec-"));
    const path = join(dir, "us-msb.json");
    writeFileSync(path, content, "utf8");
    return path;
  }

  const goodProvenance = {
    ...MODULE_RESPONSE_PROVENANCE,
    source: "recorded" as const,
    royaltyRecorded: true,
  };

  it("合法录制被接受，版税闸放行", () => {
    const path = writeRecording(
      JSON.stringify({ provenance: goodProvenance, response: SYNTHETIC_MODULE_RESPONSE }),
    );
    const loaded = loadModuleResponse(path);
    expect(loaded.provenance.source).toBe("recorded");
    expect(() => assertRoyaltyRenderable(loaded.provenance)).not.toThrow();
  });

  // 这是版税闸最容易被绕过的方式：把合成数据塞进录制槽位。
  it("source=synthetic 冒充录制 → 抛 RecordingError", () => {
    const path = writeRecording(
      JSON.stringify({
        provenance: { ...goodProvenance, source: "synthetic" },
        response: SYNTHETIC_MODULE_RESPONSE,
      }),
    );
    expect(() => loadModuleResponse(path)).toThrow(RecordingError);
  });

  it("royaltyRecorded=false 的录制 → 抛 RecordingError", () => {
    const path = writeRecording(
      JSON.stringify({
        provenance: { ...goodProvenance, royaltyRecorded: false },
        response: SYNTHETIC_MODULE_RESPONSE,
      }),
    );
    expect(() => loadModuleResponse(path)).toThrow(RecordingError);
  });

  it("响应形状不符 → 抛错（不静默退回合成数据）", () => {
    const path = writeRecording(
      JSON.stringify({ provenance: goodProvenance, response: { module: "us-msb" } }),
    );
    expect(() => loadModuleResponse(path)).toThrow();
  });

  it("文件不是合法 JSON → 抛 RecordingError", () => {
    const path = writeRecording("{ not json");
    expect(() => loadModuleResponse(path)).toThrow(RecordingError);
  });
});
