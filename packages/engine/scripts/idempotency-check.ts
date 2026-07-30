/**
 * 幂等实证：**同一案件跑三次**，断言三件事全部成立（《模块拆分》§三 D6）。
 *
 * ```
 * pnpm -F @citely/engine idempotency:check            # 用临时库，跑完自删
 * IDEMPOTENCY_DB=./data/idem.sqlite pnpm -F @citely/engine idempotency:check
 * ```
 *
 * **零网络、零密钥**：链上动作由假 writer 执行（它只产出可区分的 txHash），
 * 所以随时可跑、结果确定。要验的不是"链能不能连上"，而是
 * **"第二次运行会不会重发交易 / 重复入账 / 算出不同的 SA 哈希"**。
 *
 * 与 `src/db/rerun.test.ts` 断言同一组性质——那份进 CI，这份给人看。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnvFile } from "@citely/chain";
import type { ChainAction } from "@citely/chain/types";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { runChainSteps } from "../src/db/rerun.js";
import { openDatabase } from "../src/db/schema.js";
import { CaseStore } from "../src/db/store.js";
import { SqliteIdempotencyStore } from "../src/db/tx-log.js";
import { entriesForComplete } from "../src/ledger/entries.js";
import { DuplicateLedgerEntryError, LedgerStore } from "../src/ledger/store.js";
import { buildLegs } from "../src/policy/legs.js";
import { buildSettlementAuthorization } from "../src/sa/build.js";
import { createLogger } from "../src/util/logger.js";
import { usdc6FromDecimal } from "../src/util/usdc6.js";

const log = createLogger("idempotency-check");

/** 演示专用测试密钥（viem 文档示例值，无资金）。仅用于本地签名，不接链。 */
const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const CASE_ID = "citely-demo-0001";
const JOB_ID = 7n;
/** 链上 Job 的 expiredAt——createJob 只发生过一次，所以它跨运行固定。 */
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

interface RunOutcome {
  readonly sent: number;
  readonly reused: number;
  readonly ledgerRows: number;
  readonly netActual: bigint;
  readonly saHash: string;
}

async function runOnce(dbPath: string, sentTxs: string[]): Promise<RunOutcome> {
  const db = openDatabase(dbPath);
  try {
    const cases = new CaseStore(db);
    cases.ensureCase(CASE_ID);
    cases.setJobId(CASE_ID, JOB_ID);

    let counter = 0;
    const summary = await runChainSteps(new SqliteIdempotencyStore(db), PLAN, (action) => {
      counter += 1;
      const tx = `0x${String(counter).padStart(4, "0")}${"ee".repeat(30)}` as Hex;
      sentTxs.push(`${action}:${tx}`);
      return Promise.resolve(tx);
    });

    const ledger = new LedgerStore(db);
    try {
      ledger.recordAll(
        entriesForComplete({ caseId: CASE_ID, jobId: JOB_ID, budget: BUDGET, fees: FEES }),
      );
    } catch (err: unknown) {
      if (!(err instanceof DuplicateLedgerEntryError)) throw err;
    }

    const sa = await buildSettlementAuthorization({
      caseId: CASE_ID,
      jobId: JOB_ID,
      expiresAt: JOB_EXPIRED_AT,
      modulesUsed: [
        { module_id: "us-msb", version: "2026.07.1", evidence_hash: `0x${"ab".repeat(32)}` },
      ],
      legs: LEGS,
      itemsCovered: 5,
      account: privateKeyToAccount(DEMO_KEY),
      // 故意用真实墙上时钟：它在 attestation 里、被排除在哈希外，
      // 所以三次 sa_hash 仍必须相同。这条正是主导发现的那个 bug 的反面。
      signedAt: new Date(),
    });

    return {
      sent: summary.sentCount,
      reused: summary.reusedCount,
      ledgerRows: ledger.list(CASE_ID).length,
      netActual: ledger.netActual(CASE_ID),
      saHash: sa.attestation.sa_hash,
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  loadDotEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));

  const configured = process.env["IDEMPOTENCY_DB"];
  const useTmp = configured === undefined || configured.trim() === "";
  const tmpDir = useTmp ? mkdtempSync(join(tmpdir(), "citely-idem-")) : "";
  const dbPath = useTmp ? join(tmpDir, "data", "idem.sqlite") : configured.trim();

  try {
    // 从空库开始——冷启动是这条实证的前提。
    openDatabase(dbPath, { fresh: true }).close();

    const sentTxs: string[] = [];
    const runs: RunOutcome[] = [];
    for (const n of [1, 2, 3]) {
      const outcome = await runOnce(dbPath, sentTxs);
      runs.push(outcome);
      log.info(`run ${String(n)}`, {
        tx_sent: outcome.sent,
        tx_reused: outcome.reused,
        ledger_rows: outcome.ledgerRows,
        net_actual: outcome.netActual.toString(),
        sa_hash: outcome.saHash,
      });
    }

    const [first, second, third] = runs;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected three runs");
    }

    const failures: string[] = [];
    if (first.sent !== PLAN.length) {
      failures.push(`run 1 should send ${String(PLAN.length)} txs, sent ${String(first.sent)}`);
    }
    if (second.sent !== 0 || third.sent !== 0) {
      failures.push(`runs 2/3 must send 0 txs, sent ${String(second.sent)}/${String(third.sent)}`);
    }
    if (sentTxs.length !== PLAN.length) {
      failures.push(`only ${String(PLAN.length)} txs should ever be sent, saw ${String(sentTxs.length)}`);
    }
    if (new Set(runs.map((r) => r.ledgerRows)).size !== 1) {
      failures.push(`ledger row count drifted: ${runs.map((r) => r.ledgerRows).join("/")}`);
    }
    if (new Set(runs.map((r) => r.netActual.toString())).size !== 1) {
      failures.push(`ledger net drifted: ${runs.map((r) => r.netActual.toString()).join("/")}`);
    }
    if (new Set(runs.map((r) => r.saHash)).size !== 1) {
      failures.push(`sa_hash drifted across runs: ${runs.map((r) => r.saHash).join(" / ")}`);
    }

    if (failures.length > 0) {
      for (const failure of failures) log.error("IDEMPOTENCY FAILURE", { detail: failure });
      process.exitCode = 1;
      return;
    }

    log.info("✅ idempotency verified", {
      runs: 3,
      txs_ever_sent: sentTxs.length,
      ledger_rows: first.ledgerRows,
      sa_hash_stable: true,
      sa_hash: first.saHash,
    });
  } finally {
    if (useTmp) rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  log.error("idempotency check failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
