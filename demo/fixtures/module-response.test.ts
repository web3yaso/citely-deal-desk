import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
