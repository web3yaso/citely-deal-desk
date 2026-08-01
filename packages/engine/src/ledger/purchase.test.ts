/**
 * x402 采购 → 账本的适配层测试。
 *
 * **mock 贴着真实返回形状**：这里的 `ModuleCheckResult` 直接用 chain 导出的类型标注，
 * 字段少一个、名字改一个都编译不过。之前 chain 吞掉结算 ID 时，
 * `ref_type: "gateway_receipt"` 那一态拿不到 `ref`，而 dry-run 走录制快照
 * 永远执行不到那行——测试全绿、真实路径是空的。类型直连就是防这个。
 */

import type { ModuleCheckResult, ModuleResponse } from "@citely/chain/types";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type EngineDatabase } from "../db/schema.js";
import { usdc6, usdc6FromDecimal } from "../util/usdc6.js";
import {
  MissingSettlementIdError,
  purchaseLedgerEntries,
  royaltyLedgerEntry,
  royaltyObligationFor,
} from "./purchase.js";
import { LedgerStore } from "./store.js";

/** us-msb 真实付费录制的真值（主导 2026-07-29 同步）。 */
const MAINTAINER_WALLET = "0x76B05e56872E097dB94Ee8cD55de7882603047B9";
const ROYALTY_BPS = 500;
/** us-msb 定价 0.80 USDC。 */
const PAID = usdc6FromDecimal("0.80");
const SETTLEMENT_ID = "0xgateway-settlement-abc123";

function moduleResponse(over: Partial<ModuleResponse> = {}): ModuleResponse {
  return {
    module: "us-msb",
    version: "2026.07.1",
    updated_at: "2026-07-12T00:00:00Z",
    maintainer_wallet: MAINTAINER_WALLET,
    royalty_bps: ROYALTY_BPS,
    checks: [],
    overall: "HOLD",
    settlement_constraints: {
      module: "us-msb",
      module_version: "2026.07.1",
      deal_id: "citely-demo-0001",
      valid_until: "2026-08-01T00:00:00Z",
      blocked_check_ids: ["MT-02"],
      escalated_check_ids: [],
      evaluated_check_count: 1,
      evidence_hash: "ab".repeat(32),
    },
    evidence_hash: "ab".repeat(32),
    engine_version: "1.0.0",
    hash_scheme_version: "2",
    disclaimer: "输出为基于公开法源整理的检查项状态，不构成法律意见。",
    ...over,
  };
}

function checkResult(over: Partial<ModuleCheckResult> = {}): ModuleCheckResult {
  return {
    response: moduleResponse(),
    settlementId: SETTLEMENT_ID,
    paidAtomic: PAID,
    ...over,
  };
}

describe("purchaseLedgerEntries —— gateway_receipt 那一态真正跑起来", () => {
  it("ref = settlementId、ref_type = gateway_receipt、amount_actual = paidAtomic", () => {
    const { entries } = purchaseLedgerEntries({
      caseId: "CASE-1",
      moduleId: "us-msb",
      result: checkResult(),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      direction: "out",
      amount_nominal: PAID,
      amount_actual: PAID,
      ref: SETTLEMENT_ID,
      ref_type: "gateway_receipt",
      category: "module_fee",
      account: "procurement",
      caseId: "CASE-1",
      settlement_tx: null,
    });
  });

  it("amount_actual 来自 paidAtomic，**不按定价表推算**", () => {
    const odd = usdc6(799_999n); // 实付比定价少 1 个最小单位
    const { entries } = purchaseLedgerEntries({
      caseId: "CASE-1",
      moduleId: "us-msb",
      result: checkResult({ paidAtomic: odd }),
    });
    expect(entries[0]?.amount_actual).toBe(odd);
  });

  it("空结算 ID 响亮失败，绝不写出 ref='' 的垃圾行", () => {
    expect(() =>
      purchaseLedgerEntries({
        caseId: "CASE-1",
        moduleId: "us-msb",
        result: checkResult({ settlementId: "" }),
      }),
    ).toThrow(MissingSettlementIdError);
    expect(() =>
      purchaseLedgerEntries({
        caseId: "CASE-1",
        moduleId: "us-msb",
        result: checkResult({ settlementId: "   " }),
      }),
    ).toThrow(MissingSettlementIdError);
  });

  it("建成时 settlement_tx 为 null，等批量结算落链后补挂", () => {
    const { entries } = purchaseLedgerEntries({
      caseId: "CASE-1",
      moduleId: "us-msb",
      result: checkResult(),
    });
    expect(entries[0]?.settlement_tx).toBeNull();
  });
});

describe("royaltyObligationFor —— 真值从 response 读，不用占位", () => {
  it("us-msb 真值：0.80 × 5% = 0.04", () => {
    const obligation = royaltyObligationFor(moduleResponse(), PAID);
    expect(obligation).toEqual({
      payee: MAINTAINER_WALLET,
      amount: usdc6FromDecimal("0.04"),
      bps: 500,
    });
  });

  it("零地址 maintainer = 无版税（并行计划 §二 版税行前提）", () => {
    const response = moduleResponse({
      maintainer_wallet: "0x0000000000000000000000000000000000000000",
    });
    expect(royaltyObligationFor(response, PAID)).toBeNull();
  });

  it("零地址判断大小写不敏感", () => {
    const response = moduleResponse({
      maintainer_wallet: "0x0000000000000000000000000000000000000000".toUpperCase() as `0x${string}`,
    });
    expect(royaltyObligationFor(response, PAID)).toBeNull();
  });

  it("royalty_bps 为 0 或非法 → 无版税", () => {
    expect(royaltyObligationFor(moduleResponse({ royalty_bps: 0 }), PAID)).toBeNull();
    expect(royaltyObligationFor(moduleResponse({ royalty_bps: -1 }), PAID)).toBeNull();
    expect(royaltyObligationFor(moduleResponse({ royalty_bps: 1.5 }), PAID)).toBeNull();
  });

  it("比例太小取整为 0 时不产生 0 元行（0 元行只会误导读者）", () => {
    expect(royaltyObligationFor(moduleResponse({ royalty_bps: 1 }), usdc6(5n))).toBeNull();
  });

  it("向下取整，不四舍五入", () => {
    // 999 * 500 / 10000 = 49.95 → 49
    expect(royaltyObligationFor(moduleResponse(), usdc6(999n))?.amount).toBe(49n);
  });
});

describe("版税是独立支付，用它自己的回执", () => {
  let db: EngineDatabase;
  let ledger: LedgerStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    ledger = new LedgerStore(db, () => new Date("2026-07-29T00:00:00.000Z"));
  });

  it("模块费与版税用不同 ref，对账时不会叠在同一个回执上", () => {
    const { entries, royalty } = purchaseLedgerEntries({
      caseId: "CASE-1",
      moduleId: "us-msb",
      result: checkResult(),
    });
    expect(royalty).not.toBeNull();
    if (royalty === null) throw new Error("expected royalty");

    ledger.recordAll(entries);
    ledger.record(
      royaltyLedgerEntry({
        caseId: "CASE-1",
        obligation: royalty,
        gatewayReceipt: "0xgateway-settlement-royalty-999",
      }),
    );

    const rows = ledger.list("CASE-1");
    expect(rows.map((r) => r.category)).toEqual(["module_fee", "royalty"]);
    expect(new Set(rows.map((r) => r.ref)).size).toBe(2);
    for (const row of rows) expect(row.ref_type).toBe("gateway_receipt");
  });

  it("整条采购链路的支出合计 = 模块费 + 版税", () => {
    const { entries, royalty } = purchaseLedgerEntries({
      caseId: "CASE-1",
      moduleId: "us-msb",
      result: checkResult(),
    });
    if (royalty === null) throw new Error("expected royalty");
    ledger.recordAll(entries);
    ledger.record(
      royaltyLedgerEntry({ caseId: "CASE-1", obligation: royalty, gatewayReceipt: "gw-royalty" }),
    );
    expect(ledger.netActual("CASE-1")).toBe(-(800_000n + 40_000n));
  });

  it("两笔都待结算，补挂互不干扰", () => {
    const { entries, royalty } = purchaseLedgerEntries({
      caseId: "CASE-1",
      moduleId: "us-msb",
      result: checkResult(),
    });
    if (royalty === null) throw new Error("expected royalty");
    ledger.recordAll(entries);
    ledger.record(
      royaltyLedgerEntry({ caseId: "CASE-1", obligation: royalty, gatewayReceipt: "gw-royalty" }),
    );
    expect(ledger.pendingSettlements()).toHaveLength(2);

    expect(ledger.attachSettlementTx(SETTLEMENT_ID, `0x${"11".repeat(32)}`)).toBe(1);
    expect(ledger.pendingSettlements()).toHaveLength(1);
    expect(ledger.pendingSettlements()[0]?.category).toBe("royalty");
  });
});
