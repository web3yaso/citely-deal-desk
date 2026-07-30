/**
 * 同一案件重跑三次的幂等实证（主导 2026-07-29 要求）。
 *
 * 用**真实文件库**并在每次"运行"之间关闭再重开连接——模拟三次独立进程启动。
 * 断言三件事，缺一不算幂等：
 * 1. 链上写操作不重发（第 2、3 次 `sentCount === 0`）；
 * 2. 账本不重复入账（行数与金额三次完全一致）；
 * 3. **SA 的 `deliverableHash` 三次逐字节相同**。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChainAction } from "@citely/chain/types";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entriesForComplete } from "../ledger/entries.js";
import { DuplicateLedgerEntryError, LedgerStore } from "../ledger/store.js";
import { buildLegs } from "../policy/legs.js";
import { buildSaBody, buildSettlementAuthorization } from "../sa/build.js";
import { computeDeliverableHash } from "../sa/hash.js";
import { usdc6FromDecimal } from "../util/usdc6.js";
import { runChainSteps } from "./rerun.js";
import { openDatabase } from "./schema.js";
import { CaseStore } from "./store.js";
import { SqliteIdempotencyStore } from "./tx-log.js";

const OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const CASE_ID = "citely-demo-0001";
/** 链上 Job 与它的 expiredAt：**跨运行固定**，因为 createJob 只发生过一次。 */
const JOB_ID = 7n;
const JOB_EXPIRED_AT = BigInt(Math.floor(Date.parse("2026-08-05T00:00:00.000Z") / 1000));
const BUDGET = usdc6FromDecimal("10.00");
const FEES = { platformFeeBP: 250n, evaluatorFeeBP: 100n } as const;

const PLAN: readonly { scope: bigint | string; action: ChainAction }[] = [
  { scope: CASE_ID, action: "createJob" },
  { scope: JOB_ID, action: "setBudget" },
  { scope: JOB_ID, action: "fund" },
  { scope: JOB_ID, action: "submit" },
  { scope: JOB_ID, action: "complete" },
];

const LEGS = buildLegs([
  {
    party: "sg_payee",
    payee: "0x1111111111111111111111111111111111111111",
    amount_nominal: usdc6FromDecimal("125.00"),
    modules: [
      {
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
      },
    ],
    basis: [{ item_id: "MT-01", verdict: "confirmed_exempt", source: "31 CFR § 1010.100(ff)" }],
  },
]);

const SA_PARAMS = {
  caseId: CASE_ID,
  jobId: JOB_ID,
  // 取自链上 Job 的 expiredAt —— 不是 Date.now() + 7 天。
  expiresAt: JOB_EXPIRED_AT,
  modulesUsed: [
    { module_id: "us-msb", version: "2026.07.1", evidence_hash: `0x${"ab".repeat(32)}` as Hex },
  ],
  legs: LEGS,
  itemsCovered: 5,
};

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "citely-rerun-"));
  dbPath = join(tmp, "data", "deal-desk.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface RunOutcome {
  readonly sent: number;
  readonly reused: number;
  readonly ledgerRows: number;
  readonly netActual: bigint;
  readonly saHash: string;
  readonly txHashes: readonly string[];
}

/**
 * 跑一次完整案件。每次调用都自己开/关连接——模拟一次独立的进程启动。
 * `sentTxs` 记录"真的发出去的交易"，跨运行累计，用来证明第二次没发。
 */
async function runOnce(sentTxs: string[]): Promise<RunOutcome> {
  const db = openDatabase(dbPath);
  try {
    const cases = new CaseStore(db);
    // 重跑必须用 ensureCase：createCase 对同一 caseId 会抛错，那不是幂等。
    cases.ensureCase(CASE_ID);
    cases.setJobId(CASE_ID, JOB_ID);

    const idem = new SqliteIdempotencyStore(db);
    let counter = 0;
    const summary = await runChainSteps(idem, PLAN, (action: ChainAction) => {
      // 假链：每次调用产出一个新的、可区分的 txHash。
      counter += 1;
      const tx = `0x${action.slice(0, 2)}${String(counter).padStart(2, "0")}${"ee".repeat(30)}` as Hex;
      sentTxs.push(tx);
      return Promise.resolve(tx);
    });

    const ledger = new LedgerStore(db);
    try {
      ledger.recordAll(entriesForComplete({ caseId: CASE_ID, jobId: JOB_ID, budget: BUDGET, fees: FEES }));
    } catch (err: unknown) {
      // 第二次及以后：被幂等键挡住，这正是期望行为。
      if (!(err instanceof DuplicateLedgerEntryError)) throw err;
    }

    const sa = await buildSettlementAuthorization({
      ...SA_PARAMS,
      account: privateKeyToAccount(OPERATOR_KEY),
      // signedAt 是墙上时钟，但它在 attestation 里、被排除在哈希外。
      signedAt: new Date(),
    });

    return {
      sent: summary.sentCount,
      reused: summary.reusedCount,
      ledgerRows: ledger.list(CASE_ID).length,
      netActual: ledger.netActual(CASE_ID),
      saHash: sa.attestation.sa_hash,
      txHashes: summary.steps.map((s) => s.txHash),
    };
  } finally {
    db.close();
  }
}

describe("同一案件跑三次：幂等实证", () => {
  it("第一次发 5 笔交易，第二三次一笔都不发", async () => {
    const sentTxs: string[] = [];
    const first = await runOnce(sentTxs);
    const second = await runOnce(sentTxs);
    const third = await runOnce(sentTxs);

    expect(first.sent).toBe(5);
    expect(first.reused).toBe(0);
    expect(second.sent).toBe(0);
    expect(second.reused).toBe(5);
    expect(third.sent).toBe(0);
    expect(third.reused).toBe(5);
    // 全局只发过 5 笔，不是 15 笔。
    expect(sentTxs).toHaveLength(5);
  });

  it("三次拿到的 txHash 完全相同（复用既有交易，不是重发）", async () => {
    const sentTxs: string[] = [];
    const first = await runOnce(sentTxs);
    const second = await runOnce(sentTxs);
    const third = await runOnce(sentTxs);
    expect(second.txHashes).toEqual(first.txHashes);
    expect(third.txHashes).toEqual(first.txHashes);
  });

  it("账本三次都是 2 行、金额一致（不是 2/4/6 行）", async () => {
    const sentTxs: string[] = [];
    const first = await runOnce(sentTxs);
    const second = await runOnce(sentTxs);
    const third = await runOnce(sentTxs);

    expect([first.ledgerRows, second.ledgerRows, third.ledgerRows]).toEqual([2, 2, 2]);
    const expectedNet = 9_650_000n + 100_000n;
    expect([first.netActual, second.netActual, third.netActual]).toEqual([
      expectedNet,
      expectedNet,
      expectedNet,
    ]);
  });

  it("**SA 的 deliverableHash 三次逐字节相同**", async () => {
    const sentTxs: string[] = [];
    const hashes = [
      (await runOnce(sentTxs)).saHash,
      (await runOnce(sentTxs)).saHash,
      (await runOnce(sentTxs)).saHash,
    ];
    expect(new Set(hashes).size).toBe(1);
    // 且与独立算出来的一致（第三方可复算）。
    expect(hashes[0]).toBe(computeDeliverableHash(buildSaBody(SA_PARAMS)));
  });

  it("冷启动后重新计数（db:reset 之后是全新一轮）", async () => {
    const sentTxs: string[] = [];
    await runOnce(sentTxs);
    expect((await runOnce(sentTxs)).sent).toBe(0);

    // 清库 = 彩排的下一轮。
    openDatabase(dbPath, { fresh: true }).close();
    const afterReset = await runOnce(sentTxs);
    expect(afterReset.sent).toBe(5);
    expect(afterReset.ledgerRows).toBe(2);
  });
});

describe("ensureCase：重跑入口", () => {
  it("首次建案，之后原样返回，不抛错", () => {
    const db = openDatabase(dbPath);
    const cases = new CaseStore(db);
    expect(cases.ensureCase(CASE_ID).state).toBe("intake");
    cases.transitionCase(CASE_ID, "decomposed");
    // 第二次运行：接着既有状态走，而不是崩掉或被重置。
    expect(cases.ensureCase(CASE_ID).state).toBe("decomposed");
    db.close();
  });
});
