/**
 * `GET /cases/:id` 的查询适配：把 engine 的两张表拼成一条对外记录。
 *
 * 状态取自 **`cases` 表**（合约 §3：案件状态机是唯一真相源，链上状态只用于对账），
 * SA 与三检结论取自 `case_runs` 的运行快照——engine 明确保证那份快照 JSON 安全，
 * 所以可以原样回给调用方，不必再翻译一遍（翻译层是丢字段的常见来源）。
 */

import type { ModuleResponse } from "@citely/chain";
import type { CaseRow } from "@citely/engine/db";
import type { CaseRunRecord } from "@citely/engine/orchestrator";

import type { CaseReader, CaseRecord } from "./ports.js";

/** 只取本模块用得到的读方法，便于单测注入替身。 */
export interface CaseReaderStores {
  readonly cases: { findCase(caseId: string): CaseRow | null };
  readonly runs: { find(caseId: string): CaseRunRecord | null };
  readonly purchases: {
    list(caseId: string): readonly { moduleId: string; response: ModuleResponse }[];
  };
}

/**
 * 创建案件查询端口。
 *
 * @param stores - 案件表与运行快照表
 * @returns 可注入 `createApp` 的 {@link CaseReader}
 */
export function createCaseReader(stores: CaseReaderStores): CaseReader {
  return {
    readCase: (caseId) => {
      const row = stores.cases.findCase(caseId);
      if (row === null) return Promise.resolve(undefined);

      const run = stores.runs.find(caseId);
      const record: CaseRecord = {
        caseId: row.case_id,
        state: row.state,
        // exit_reason 为 null 表示"尚未终局"，此时**不输出该字段**，
        // 而不是输出一个 null——两者对调用方是不同的意思。
        ...(row.exit_reason === null ? {} : { exitReason: row.exit_reason }),
        jobId: row.job_id,
        snapshot: run?.snapshot ?? null,
        // 买到的逐条 check 是腿上 condition 的出处，与快照一起回给案件页。
        moduleResults: stores.purchases.list(caseId).map((p) => ({
          moduleId: p.moduleId,
          version: p.response.version,
          overall: p.response.overall,
          evidenceHash: p.response.evidence_hash,
          checks: p.response.checks,
        })),
        // 失败原因如实透出（engine 落库前已脱敏）：没有它，
        // 调用方对 "Case execution failed" 只能猜到底卡在哪一步。
        ...(run === null ? {} : { runStatus: run.status }),
        ...(run === null || run.error === null ? {} : { runError: run.error }),
        updatedAt: row.updated_at,
      };
      return Promise.resolve(record);
    },
  };
}
