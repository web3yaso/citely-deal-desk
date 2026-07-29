import { splitFees } from "@citely/chain";
import type { JobFeeRates } from "@citely/chain/types";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type EngineDatabase } from "../db/schema.js";
import { usdc6, usdc6FromDecimal } from "../util/usdc6.js";
import {
  entriesForComplete,
  entryFor,
  entryForModuleFee,
  entryForRefund,
  entryForRoyalty,
} from "./entries.js";
import { DuplicateLedgerEntryError, LedgerStore, SettlementAttachError } from "./store.js";
import {
  assertRefTypeForCategory,
  LEDGER_CATEGORIES,
  LEDGER_REF_TYPES,
  LedgerRefTypeError,
  type LedgerEntry,
} from "./types.js";

/** `noUncheckedIndexedAccess` 下取第一个元素，缺失即测试失败（不用类型断言绕过）。 */
function first(entries: readonly LedgerEntry[]): LedgerEntry {
  const entry = entries[0];
  if (entry === undefined) throw new Error("expected at least one ledger entry");
  return entry;
}

/** 链上读到的费率（测试里显式给出——生产路径必须来自 getFeeRates()，不许硬编码）。 */
const FEES: JobFeeRates = { platformFeeBP: 250n, evaluatorFeeBP: 100n };
/** 案件费 10.00 USDC（1:100 比例尺）。 */
const BUDGET = usdc6FromDecimal("10.00");
const RECEIPT = "gw-receipt-0001";
const TX = `0x${"ab".repeat(32)}`;

let db: EngineDatabase;
let ledger: LedgerStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new LedgerStore(db, () => new Date("2026-07-28T00:00:00.000Z"));
});

describe("v2.3 §3.5 契约", () => {
  it("category 六态不多不少", () => {
    expect([...LEDGER_CATEGORIES].sort()).toEqual([
      "case_fee",
      "kyb_data",
      "module_fee",
      "refund",
      "reserve_release",
      "royalty",
    ]);
  });

  it("ref_type 三态", () => {
    expect(LEDGER_REF_TYPES).toEqual(["jobId", "gateway_receipt", "txHash"]);
  });

  it.each([
    ["case_fee", "jobId"],
    ["reserve_release", "jobId"],
    ["module_fee", "gateway_receipt"],
    ["royalty", "gateway_receipt"],
    ["refund", "txHash"],
  ] as const)("%s 必须用 ref_type=%s", (category, refType) => {
    expect(() => {
      assertRefTypeForCategory(category, refType);
    }).not.toThrow();
    const wrong = refType === "jobId" ? "txHash" : "jobId";
    expect(() => {
      assertRefTypeForCategory(category, wrong);
    }).toThrow(LedgerRefTypeError);
  });

  it("kyb_data 不被 §3.5 点名，三种 ref_type 都放行（不替文档做决定）", () => {
    for (const refType of LEDGER_REF_TYPES) {
      expect(() => {
        assertRefTypeForCategory("kyb_data", refType);
      }).not.toThrow();
    }
  });
});

describe("entriesForComplete —— 按净额对账（合约 §2.4），ref_type=jobId", () => {
  const params = { caseId: "CASE-1", jobId: 42n, budget: BUDGET, fees: FEES };

  it("运营钱包那笔：nominal = budget，actual = net，ref = jobId", () => {
    const operator = first(entriesForComplete(params));
    const { net } = splitFees(BUDGET, FEES);
    expect(operator).toEqual({
      direction: "in",
      amount_nominal: BUDGET,
      amount_actual: net,
      ref: "42",
      ref_type: "jobId",
      category: "case_fee",
      account: "operator",
      caseId: "CASE-1",
      settlement_tx: null,
    });
    expect(net).toBe(9_650_000n);
  });

  it("验证器钱包收到的 evalFee 也入账，方向为 in", () => {
    const verifier = entriesForComplete(params)[1];
    expect(verifier?.account).toBe("verifier");
    expect(verifier?.direction).toBe("in");
    expect(verifier?.amount_actual).toBe(splitFees(BUDGET, FEES).evaluatorFee);
    expect(verifier?.amount_actual).toBe(100_000n);
  });

  it("nominal 与 actual 的差额恰好是 platformFee + evalFee", () => {
    const operator = first(entriesForComplete(params));
    const { platformFee, evaluatorFee } = splitFees(BUDGET, FEES);
    expect(operator.amount_nominal - operator.amount_actual).toBe(platformFee + evaluatorFee);
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

describe("entryForModuleFee —— x402 付款那一刻只有回执（v2.3 §3.5 的全部理由）", () => {
  it("ref 是 Gateway 回执，settlement_tx 建成时为 null", () => {
    const entry = entryForModuleFee({
      caseId: "CASE-1",
      quoted: usdc6FromDecimal("0.80"),
      paid: usdc6FromDecimal("0.80"),
      gatewayReceipt: RECEIPT,
    });
    expect(entry).toEqual({
      direction: "out",
      amount_nominal: 800_000n,
      amount_actual: 800_000n,
      ref: RECEIPT,
      ref_type: "gateway_receipt",
      category: "module_fee",
      account: "procurement",
      caseId: "CASE-1",
      settlement_tx: null,
    });
  });

  it("版税同样挂回执", () => {
    const entry = entryForRoyalty({
      caseId: "CASE-1",
      amount: usdc6FromDecimal("0.04"),
      gatewayReceipt: RECEIPT,
    });
    expect(entry.ref_type).toBe("gateway_receipt");
    expect(entry.category).toBe("royalty");
  });
});

describe("entryForRefund —— 真实链上转账，有 txHash", () => {
  it("方向 out、account 为 escrow、ref_type 为 txHash", () => {
    const entry = entryForRefund({
      caseId: "CASE-1",
      txHash: TX,
      budget: BUDGET,
      refunded: BUDGET,
    });
    expect(entry.direction).toBe("out");
    expect(entry.ref_type).toBe("txHash");
    expect(entry.ref).toBe(TX);
    expect(entry.account).toBe("escrow");
  });

  it("链上实退与名义不等时如实记录，不平账", () => {
    const entry = entryForRefund({
      caseId: "CASE-1",
      txHash: TX,
      budget: BUDGET,
      refunded: usdc6(BUDGET - 1n),
    });
    expect(entry.amount_nominal).toBe(BUDGET);
    expect(entry.amount_actual).toBe(BUDGET - 1n);
  });
});

describe("entryFor 通用构造", () => {
  it("reserve_release 用 jobId", () => {
    const entry = entryFor({
      caseId: "CASE-1",
      ref: "42",
      ref_type: "jobId",
      category: "reserve_release",
      direction: "out",
      amountNominal: usdc6FromDecimal("2.00"),
      amountActual: usdc6FromDecimal("2.00"),
      account: "operator",
    });
    expect(entry.ref_type).toBe("jobId");
  });

  it("用错 ref_type 在构造时就被挡下，不会进库", () => {
    expect(() =>
      entryFor({
        caseId: "CASE-1",
        ref: TX,
        ref_type: "txHash",
        category: "module_fee",
        direction: "out",
        amountNominal: usdc6(1n),
        amountActual: usdc6(1n),
        account: "procurement",
      }),
    ).toThrow(LedgerRefTypeError);
  });
});

describe("LedgerStore", () => {
  const completeParams = { caseId: "CASE-1", jobId: 42n, budget: BUDGET, fees: FEES };

  it("入账后可读回，金额往返仍是最小单位 bigint", () => {
    ledger.recordAll(entriesForComplete(completeParams));
    const rows = ledger.list("CASE-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.amount_actual).toBe(9_650_000n);
    expect(typeof rows[0]?.amount_nominal).toBe("bigint");
    expect(rows[0]?.ref).toBe("42");
  });

  it("同一 ref 的两笔进账因 account 不同而共存", () => {
    ledger.recordAll(entriesForComplete(completeParams));
    expect(ledger.list().map((e) => e.account)).toEqual(["operator", "verifier"]);
  });

  it("重复入账报错（重试不重复记账）", () => {
    const entries = entriesForComplete(completeParams);
    ledger.recordAll(entries);
    expect(() => {
      ledger.record(first(entries));
    }).toThrow(DuplicateLedgerEntryError);
    expect(ledger.list()).toHaveLength(2);
  });

  it("批量入账遇重复整批回滚", () => {
    const entries = entriesForComplete(completeParams);
    ledger.record(first(entries));
    expect(() => {
      ledger.recordAll(entries);
    }).toThrow(DuplicateLedgerEntryError);
    expect(ledger.list()).toHaveLength(1);
  });

  it("ref_type 非法值被 CHECK 约束挡在库外", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO ledger (case_id, direction, amount_nominal, amount_actual, ref,
             ref_type, category, account, settlement_tx, recorded_at)
           VALUES ('C','in','1','1','r','bogus','case_fee','operator',NULL,'t')`,
        )
        .run(),
    ).toThrow();
  });
});

describe("attachSettlementTx —— 批量结算后补挂（v2.3 §3.5）", () => {
  beforeEach(() => {
    ledger.record(
      entryForModuleFee({
        caseId: "CASE-1",
        quoted: usdc6FromDecimal("0.80"),
        paid: usdc6FromDecimal("0.80"),
        gatewayReceipt: RECEIPT,
      }),
    );
    ledger.record(
      entryForRoyalty({
        caseId: "CASE-1",
        amount: usdc6FromDecimal("0.04"),
        gatewayReceipt: RECEIPT,
      }),
    );
  });

  it("补挂前是待结算，补挂后同回执的所有行都带上结算 tx", () => {
    expect(ledger.pendingSettlements()).toHaveLength(2);
    expect(ledger.attachSettlementTx(RECEIPT, TX)).toBe(2);
    expect(ledger.pendingSettlements()).toHaveLength(0);
    for (const entry of ledger.list("CASE-1")) {
      expect(entry.settlement_tx).toBe(TX);
      // 回执仍在：同一行同时有回执与结算 tx，正是 §3.5 要的形态。
      expect(entry.ref).toBe(RECEIPT);
    }
  });

  it("重复补挂同一个 tx 幂等（结算轮询会重复看到同一笔）", () => {
    ledger.attachSettlementTx(RECEIPT, TX);
    expect(ledger.attachSettlementTx(RECEIPT, TX)).toBe(0);
  });

  it("改挂成另一个 tx 报错，绝不覆盖", () => {
    ledger.attachSettlementTx(RECEIPT, TX);
    expect(() => ledger.attachSettlementTx(RECEIPT, `0x${"cd".repeat(32)}`)).toThrow(
      SettlementAttachError,
    );
  });

  it("回执不存在报错", () => {
    expect(() => ledger.attachSettlementTx("nope", TX)).toThrow(SettlementAttachError);
  });
});

describe("汇总", () => {
  it("netActual：进账减支出", () => {
    ledger.recordAll(entriesForComplete({ caseId: "CASE-1", jobId: 42n, budget: BUDGET, fees: FEES }));
    ledger.record(
      entryForModuleFee({
        caseId: "CASE-1",
        quoted: usdc6FromDecimal("0.80"),
        paid: usdc6FromDecimal("0.80"),
        gatewayReceipt: RECEIPT,
      }),
    );
    expect(ledger.netActual("CASE-1")).toBe(9_650_000n + 100_000n - 800_000n);
  });

  it("totalActual 按类目合计", () => {
    ledger.recordAll(entriesForComplete({ caseId: "CASE-1", jobId: 42n, budget: BUDGET, fees: FEES }));
    expect(ledger.totalActual("case_fee", "CASE-1")).toBe(9_750_000n);
    expect(ledger.totalActual("module_fee", "CASE-1")).toBe(0n);
  });

  it("caseId 过滤生效", () => {
    ledger.record(
      entryForModuleFee({
        caseId: "CASE-2",
        quoted: usdc6(1n),
        paid: usdc6(1n),
        gatewayReceipt: "gw-2",
      }),
    );
    expect(ledger.list("CASE-1")).toHaveLength(0);
    expect(ledger.list()).toHaveLength(1);
  });
});
