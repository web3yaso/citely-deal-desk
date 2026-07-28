import { splitFees } from "@citely/chain";
import type { JobFeeRates } from "@citely/chain/types";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type EngineDatabase } from "../db/schema.js";
import { entriesForComplete, entryFor, entryForModuleFee, entryForRefund } from "./entries.js";
import { DuplicateLedgerEntryError, LedgerStore } from "./store.js";
import { LEDGER_CATEGORIES, type LedgerEntry } from "./types.js";

/** `noUncheckedIndexedAccess` 下取第一个元素，缺失即测试失败（不用类型断言绕过）。 */
function first(entries: readonly LedgerEntry[]): LedgerEntry {
  const entry = entries[0];
  if (entry === undefined) throw new Error("expected at least one ledger entry");
  return entry;
}

/** 链上读到的费率（测试里显式给出——生产路径必须来自 getFeeRates()，不许硬编码）。 */
const FEES: JobFeeRates = { platformFeeBP: 250n, evaluatorFeeBP: 100n };
/** 案件费 10.00 USDC（1:100 比例尺，6 位小数原子单位）。 */
const BUDGET = 10_000_000n;
const TX = `0x${"ab".repeat(32)}`;

let db: EngineDatabase;
let ledger: LedgerStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new LedgerStore(db, () => new Date("2026-07-28T00:00:00.000Z"));
});

describe("category 全集逐字照录合约 §7", () => {
  it("六个取值，不多不少", () => {
    expect([...LEDGER_CATEGORIES].sort()).toEqual([
      "case_fee",
      "kyb_data",
      "module_fee",
      "refund",
      "reserve_release",
      "royalty",
    ]);
  });
});

describe("entriesForComplete —— 按净额对账（合约 §2.4）", () => {
  const params = { caseId: "CASE-1", jobId: 42n, txHash: TX, budget: BUDGET, fees: FEES };

  it("运营钱包那笔：nominal = budget，actual = net", () => {
    const [operator] = entriesForComplete(params);
    const { net } = splitFees(BUDGET, FEES);
    expect(operator).toEqual({
      direction: "in",
      amount_nominal: BUDGET,
      amount_actual: net,
      jobId: 42n,
      txHash: TX,
      category: "case_fee",
      account: "operator",
      caseId: "CASE-1",
    });
    expect(net).toBe(9_650_000n);
  });

  it("验证器钱包收到的 evalFee 也入账，方向为 in", () => {
    const entries = entriesForComplete(params);
    const verifier = entries[1];
    expect(verifier?.account).toBe("verifier");
    expect(verifier?.direction).toBe("in");
    expect(verifier?.amount_actual).toBe(splitFees(BUDGET, FEES).evaluatorFee);
    expect(verifier?.amount_actual).toBe(100_000n);
  });

  it("nominal 与 actual 的差额恰好是 platformFee + evalFee", () => {
    const [operator] = entriesForComplete(params);
    const { platformFee, evaluatorFee } = splitFees(BUDGET, FEES);
    expect((operator?.amount_nominal ?? 0n) - (operator?.amount_actual ?? 0n)).toBe(
      platformFee + evaluatorFee,
    );
  });

  it("费率为 0 时 net = budget（费率来自入参，代码里没有硬编码数字）", () => {
    const entries = entriesForComplete({
      ...params,
      fees: { platformFeeBP: 0n, evaluatorFeeBP: 0n },
    });
    expect(entries[0]?.amount_actual).toBe(BUDGET);
    expect(entries[1]?.amount_actual).toBe(0n);
  });
});

describe("entryForRefund", () => {
  it("方向 out、account 为 escrow（资金全程不经我方地址）", () => {
    const entry = entryForRefund({
      caseId: "CASE-1",
      jobId: 42n,
      txHash: TX,
      budget: BUDGET,
      refunded: BUDGET,
    });
    expect(entry.direction).toBe("out");
    expect(entry.category).toBe("refund");
    expect(entry.account).toBe("escrow");
    expect(entry.amount_actual).toBe(BUDGET);
  });

  it("链上实退金额与名义不等时如实记录，不平账", () => {
    const entry = entryForRefund({
      caseId: "CASE-1",
      jobId: 42n,
      txHash: TX,
      budget: BUDGET,
      refunded: BUDGET - 1n,
    });
    expect(entry.amount_nominal).toBe(BUDGET);
    expect(entry.amount_actual).toBe(BUDGET - 1n);
  });
});

describe("entryForModuleFee / entryFor", () => {
  it("x402 采购是采购钱包的支出，无 jobId", () => {
    const entry = entryForModuleFee({
      caseId: "CASE-1",
      quoted: 800_000n,
      paid: 800_000n,
      settlementId: "settlement-1",
    });
    expect(entry).toEqual({
      direction: "out",
      amount_nominal: 800_000n,
      amount_actual: 800_000n,
      jobId: null,
      txHash: "settlement-1",
      category: "module_fee",
      account: "procurement",
      caseId: "CASE-1",
    });
  });

  it("通用构造覆盖 royalty / kyb_data / reserve_release", () => {
    const entry = entryFor({
      caseId: "CASE-1",
      txHash: TX,
      category: "royalty",
      direction: "out",
      amountNominal: 40_000n,
      amountActual: 40_000n,
      account: "procurement",
    });
    expect(entry.category).toBe("royalty");
    expect(entry.jobId).toBeNull();
  });
});

describe("LedgerStore", () => {
  it("入账后可读回，金额往返仍是 bigint", () => {
    ledger.recordAll(
      entriesForComplete({ caseId: "CASE-1", jobId: 42n, txHash: TX, budget: BUDGET, fees: FEES }),
    );
    const rows = ledger.list("CASE-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.amount_actual).toBe(9_650_000n);
    expect(typeof rows[0]?.amount_nominal).toBe("bigint");
    expect(rows[0]?.jobId).toBe(42n);
  });

  it("同一 tx 的两笔进账因 account 不同而共存", () => {
    const entries = entriesForComplete({
      caseId: "CASE-1",
      jobId: 42n,
      txHash: TX,
      budget: BUDGET,
      fees: FEES,
    });
    ledger.recordAll(entries);
    expect(ledger.list().map((e) => e.account)).toEqual(["operator", "verifier"]);
  });

  it("重复入账报错（重试不重复记账）", () => {
    const entries = entriesForComplete({
      caseId: "CASE-1",
      jobId: 42n,
      txHash: TX,
      budget: BUDGET,
      fees: FEES,
    });
    ledger.recordAll(entries);
    expect(() => {
      ledger.record(first(entries));
    }).toThrow(DuplicateLedgerEntryError);
    expect(ledger.list()).toHaveLength(2);
  });

  it("批量入账遇重复整批回滚", () => {
    const entries = entriesForComplete({
      caseId: "CASE-1",
      jobId: 42n,
      txHash: TX,
      budget: BUDGET,
      fees: FEES,
    });
    ledger.record(first(entries));
    expect(() => {
      ledger.recordAll(entries);
    }).toThrow(DuplicateLedgerEntryError);
    expect(ledger.list()).toHaveLength(1);
  });

  it("netActual：进账减支出", () => {
    ledger.recordAll(
      entriesForComplete({ caseId: "CASE-1", jobId: 42n, txHash: TX, budget: BUDGET, fees: FEES }),
    );
    ledger.record(
      entryForModuleFee({
        caseId: "CASE-1",
        quoted: 800_000n,
        paid: 800_000n,
        settlementId: "settlement-1",
      }),
    );
    expect(ledger.netActual("CASE-1")).toBe(9_650_000n + 100_000n - 800_000n);
  });

  it("caseId 过滤生效", () => {
    ledger.record(
      entryForModuleFee({
        caseId: "CASE-2",
        quoted: 1n,
        paid: 1n,
        settlementId: "settlement-2",
      }),
    );
    expect(ledger.list("CASE-1")).toHaveLength(0);
    expect(ledger.list()).toHaveLength(1);
  });
});
