import type { CaseRow } from "@citely/engine/db";
import type { CaseRunRecord, CaseRunSnapshot } from "@citely/engine/orchestrator";
import { describe, expect, it } from "vitest";

import { createCaseReader } from "./case-reader.js";
import type { CaseReaderStores } from "./case-reader.js";

const ROW: CaseRow = {
  case_id: "case-001",
  state: "settled",
  exit_reason: "completed",
  job_id: "159786",
  created_at: "2026-07-30T00:00:00.000Z",
  updated_at: "2026-07-30T01:00:00.000Z",
};

const SNAPSHOT = { caseId: "case-001", jobId: "159786" } as CaseRunSnapshot;

function stores(
  row: CaseRow | null,
  run: CaseRunRecord | null,
  purchases: ReturnType<CaseReaderStores["purchases"]["list"]> = [],
): CaseReaderStores {
  return {
    cases: { findCase: () => row },
    runs: { find: () => run },
    purchases: { list: () => purchases },
  };
}

function runRecord(snapshot: CaseRunSnapshot | null): CaseRunRecord {
  return {
    caseId: "case-001",
    requestHash: "hash",
    status: "succeeded",
    snapshot,
    error: null,
    startedAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
  };
}

describe("createCaseReader", () => {
  it("拼出案件状态与运行快照", async () => {
    const record = await createCaseReader(stores(ROW, runRecord(SNAPSHOT))).readCase("case-001");
    expect(record).toEqual({
      caseId: "case-001",
      state: "settled",
      exitReason: "completed",
      jobId: "159786",
      snapshot: SNAPSHOT,
      moduleResults: [],
      runStatus: "succeeded",
      updatedAt: "2026-07-30T01:00:00.000Z",
    });
  });

  it("运行失败时透出脱敏后的失败原因", async () => {
    const failed: CaseRunRecord = {
      ...runRecord(null),
      status: "failed",
      error: "ChainError: submit reverted",
    };
    const record = await createCaseReader(stores(ROW, failed)).readCase("case-001");
    expect(record?.runStatus).toBe("failed");
    expect(record?.runError).toBe("ChainError: submit reverted");
  });

  it("买到的 Module 结果原样透出（condition 的出处）", async () => {
    const response = {
      version: "2026.07.1",
      overall: "HOLD",
      evidence_hash: "e".repeat(64),
      checks: [
        {
          id: "us-fincen-registration-money-transmission",
          result: "HOLD",
          basis: "missing_evidence",
          reason: "缺少所需证据：fincen_msb_registration",
          source: "31 CFR § 1022.380",
        },
      ],
    };
    const record = await createCaseReader(
      stores(ROW, runRecord(SNAPSHOT), [
        { moduleId: "us-msb", response: response as never },
      ]),
    ).readCase("case-001");
    expect(record?.moduleResults).toEqual([
      {
        moduleId: "us-msb",
        version: "2026.07.1",
        overall: "HOLD",
        evidenceHash: "e".repeat(64),
        checks: response.checks,
      },
    ]);
  });

  it("案件不存在时返回 undefined", async () => {
    expect(await createCaseReader(stores(null, null)).readCase("nope")).toBeUndefined();
  });

  it("尚未终局时不输出 exit_reason 字段（不是输出 null）", async () => {
    const pending: CaseRow = { ...ROW, state: "assessing", exit_reason: null };
    const record = await createCaseReader(stores(pending, null)).readCase("case-001");
    expect(record).toBeDefined();
    expect("exitReason" in record!).toBe(false);
  });

  it("有案件但还没有运行快照时 snapshot 为 null", async () => {
    const record = await createCaseReader(stores(ROW, null)).readCase("case-001");
    expect(record?.snapshot).toBeNull();
  });

  it("运行记录存在但快照为空时同样是 null", async () => {
    const record = await createCaseReader(stores(ROW, runRecord(null))).readCase("case-001");
    expect(record?.snapshot).toBeNull();
  });

  it("尚未建 Job 时 job_id 为 null", async () => {
    const record = await createCaseReader(stores({ ...ROW, job_id: null }, null)).readCase("c");
    expect(record?.jobId).toBeNull();
  });
});
