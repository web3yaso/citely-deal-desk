/**
 * 采购幂等的单测。
 *
 * **mock 贴着真实返回形状**：`X402Client` 与 `ModuleCheckResult` 都用 chain 导出的
 * 类型标注，chain 哪天改返回形状，这里在编译期就红。
 */

import type { ModuleCheckResult, ModuleResponse, X402Client } from "@citely/chain/types";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type EngineDatabase } from "../db/schema.js";
import { usdc6FromDecimal } from "../util/usdc6.js";
import {
  procureOnce,
  ProcurementFailedError,
  PurchaseRecordError,
  PurchaseStore,
} from "./purchase-store.js";

const CASE_ID = "citely-demo-0001";
const PAID = usdc6FromDecimal("0.80");

function moduleResponse(): ModuleResponse {
  return {
    module: "us-msb",
    version: "2026.07.1",
    updated_at: "2026-07-12T00:00:00Z",
    maintainer_wallet: "0x76B05e56872E097dB94Ee8cD55de7882603047B9",
    royalty_bps: 500,
    checks: [{ id: "MT-02", result: "HOLD", reason: "no MSB registration on file", source: "31 CFR" }],
    overall: "HOLD",
    settlement_constraints: {
      module: "us-msb",
      module_version: "2026.07.1",
      deal_id: CASE_ID,
      valid_until: "2026-08-01T00:00:00Z",
      blocked_check_ids: ["MT-02"],
      escalated_check_ids: [],
      evidence_hash: "ab".repeat(32),
    },
    evidence_hash: "ab".repeat(32),
    disclaimer: "输出为基于公开法源整理的检查项状态，不构成法律意见。",
  };
}

/** 计数用的假 x402：每次调用都记一笔，测试据此断言"到底付了几次款"。 */
function fakeX402(settlementId = "gw-1"): X402Client & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check: (moduleId): Promise<ModuleCheckResult> => {
      calls.push(moduleId);
      return Promise.resolve({ response: moduleResponse(), settlementId, paidAtomic: PAID });
    },
  };
}

const DEAL = { deal_id: CASE_ID } as unknown as Parameters<X402Client["check"]>[1];

describe("PurchaseStore / procureOnce", () => {
  let db: EngineDatabase;
  let store: PurchaseStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new PurchaseStore(db);
  });

  it("首次采购真付款并落库", async () => {
    const x402 = fakeX402();
    const result = await procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL });

    expect(result.reused).toBe(false);
    expect(result.record.settlementId).toBe("gw-1");
    expect(result.record.paidAtomic).toBe(PAID);
    expect(x402.calls).toEqual(["us-msb"]);
  });

  it("同案件同 Module 重发 → 复用既有采购，**一分钱都不再付**（不变量 6）", async () => {
    const x402 = fakeX402();
    await procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL });
    const second = await procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL });

    expect(second.reused).toBe(true);
    expect(second.record.settlementId).toBe("gw-1");
    // 这一条是本模块存在的全部理由：付款只发生过一次。
    expect(x402.calls).toEqual(["us-msb"]);
  });

  it("不同案件各买各的（幂等键含 caseId）", async () => {
    const x402 = fakeX402();
    await procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL });
    await procureOnce({ store, x402, caseId: "other-case", moduleId: "us-msb", dealInput: DEAL });

    expect(x402.calls).toHaveLength(2);
  });

  it("空结算 ID 视为付款失败：不落库、不入账", async () => {
    const x402 = fakeX402("   ");
    await expect(
      procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL }),
    ).rejects.toThrow(ProcurementFailedError);

    expect(store.find(CASE_ID, "us-msb")).toBeNull();
  });

  it("并发同 key 只留第一条记录，不互相覆盖", async () => {
    const x402 = fakeX402();
    await procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL });
    const again = store.record({
      caseId: CASE_ID,
      moduleId: "us-msb",
      response: moduleResponse(),
      settlementId: "gw-LATER",
      paidAtomic: PAID,
    });

    expect(again.settlementId).toBe("gw-1");
  });

  it("落盘记录损坏要响亮失败——静默当作没买过就会重复付款", async () => {
    const x402 = fakeX402();
    await procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL });
    db.prepare(`UPDATE purchases SET response_json = ? WHERE case_id = ?`).run("{broken", CASE_ID);

    expect(() => store.find(CASE_ID, "us-msb")).toThrow(PurchaseRecordError);
  });

  it("list 按 module 排序返回本案全部采购", async () => {
    const x402 = fakeX402();
    await procureOnce({ store, x402, caseId: CASE_ID, moduleId: "us-msb", dealInput: DEAL });
    expect(store.list(CASE_ID).map((r) => r.moduleId)).toEqual(["us-msb"]);
  });
});
