/**
 * 编排入口的单测。**零网络、零密钥**——链上写、x402、三检、收口全是注入的替身，
 * 所以这里验的不是"链能不能连上"，而是编排本身的性质：
 *
 * 1. 全流程跑通并产出签名 SA；
 * 2. **同一请求重发不重复建 Job、不重复付费、不重复入账**（HTTP 语境的新要求）；
 * 3. 并发调用安全：同 caseId 只跑一份，不同 caseId 互不干扰；
 * 4. 不变量 2 不松动、`sa_hash` 跨请求稳定；
 * 5. 失败要留痕并原样抛出，重试能接管且不产生重复副作用。
 */

import type {
  CreateJobParams,
  CreateJobResult,
  JobClient,
  JobFeeRates,
  JobState,
  JobView,
  ModuleCheckResult,
  ModuleResponse,
  X402Client,
} from "@citely/chain/types";
import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { InMemoryGoldenCache } from "../adjudicator/cache.js";
import { FakeAdjudicatorLLM } from "../adjudicator/llm/fake.js";
import { openDatabase, type EngineDatabase } from "../db/schema.js";
import { CaseStore } from "../db/store.js";
import { LedgerStore } from "../ledger/store.js";
import type { LoadedRubric } from "../rubric/types.js";
import { usdc6FromDecimal } from "../util/usdc6.js";
import { PurchaseStore } from "./purchase-store.js";
import { CaseRequestConflictError, CaseRunStore } from "./run-store.js";
import { EscalationConfigMissingError, IntakeRejectedError, runCase } from "./run-case.js";
import type { CaseRequest, CaseStores, RunCaseDeps, VerificationReportView } from "./types.js";

/** viem 文档示例密钥，无资金，仅本地签名。 */
const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PAYEE = "0x000000000000000000000000000000000000bEEF" as const;
const PROVIDER = "0x1111111111111111111111111111111111111111" as const;
const EVALUATOR = "0x2222222222222222222222222222222222222222" as const;
const CLIENT = "0x3333333333333333333333333333333333333333" as const;
const JOB_EXPIRED_AT = BigInt(Math.floor(Date.parse("2026-12-31T00:00:00.000Z") / 1000));
const REASON_HASH = `0x${"ef".repeat(32)}` as Hex;

const RUBRIC: LoadedRubric = {
  id: "us-msb",
  rubric: {
    scenario: "us-msb",
    version: "2026.07",
    last_verified_date: "2026-07-12",
    author: { name: "citely", license: "CC-BY-4.0", wallet: PAYEE },
    royalty_bps: 500,
    items: [
      {
        id: "MT-01",
        question: "是否构成 money transmitter？",
        signals: ["接收资金"],
        acceptance_criteria: ["有证据"],
        common_rejection_reasons: ["只描述了收款"],
        source: "31 CFR § 1010.100(ff)",
        confidence_rule: "任一 signal 缺失 → gray_data",
      },
    ],
    verdict_states: ["confirmed_in_scope", "confirmed_exempt", "gray_interpretive"],
  },
};

function moduleResponse(): ModuleResponse {
  return {
    module: "us-msb",
    version: "2026.07.1",
    updated_at: "2026-07-12T00:00:00Z",
    maintainer_wallet: "0x76B05e56872E097dB94Ee8cD55de7882603047B9",
    royalty_bps: 500,
    checks: [{ id: "MT-02", result: "HOLD", reason: "no registration", source: "31 CFR" }],
    overall: "HOLD",
    settlement_constraints: {
      module: "us-msb",
      module_version: "2026.07.1",
      deal_id: "citely-demo-0001",
      valid_until: "2026-08-01T00:00:00Z",
      blocked_check_ids: ["MT-02"],
      escalated_check_ids: [],
      evidence_hash: "ab".repeat(32),
    },
    evidence_hash: "ab".repeat(32),
    disclaimer: "输出为基于公开法源整理的检查项状态，不构成法律意见。",
  };
}

/**
 * 假 JobClient：**自带幂等**，与真实实现同一条纪律
 * （进入即查 key，命中直接返回既有 txHash，不"发交易"）。
 * `writes` 记录真正"发出去"的交易，测试据它断言重发有没有重复上链。
 */
class FakeJobClient implements JobClient {
  public readonly writes: string[] = [];
  public state: JobState = "open";

  private readonly sent = new Map<string, Hex>();
  private nextJobId = 7n;
  private readonly jobs = new Map<string, JobView>();

  public createJob(p: CreateJobParams): Promise<CreateJobResult> {
    const key = `${p.caseId}:createJob`;
    const existing = this.jobs.get(key);
    if (existing !== undefined) {
      return Promise.resolve({ jobId: existing.id, txHash: this.sent.get(key) as Hex });
    }
    const jobId = this.nextJobId;
    this.nextJobId += 1n;
    const txHash = this.send(key);
    this.jobs.set(key, {
      id: jobId,
      client: CLIENT,
      provider: p.provider,
      evaluator: p.evaluator,
      description: p.description,
      budget: 0n,
      expiredAt: p.expiredAt,
      status: "open",
      hook: "0x0000000000000000000000000000000000000000",
    });
    return Promise.resolve({ jobId, txHash });
  }

  public setBudget(jobId: bigint): Promise<Hex> {
    this.state = "open";
    return Promise.resolve(this.send(`${jobId.toString()}:setBudget`));
  }

  public fund(jobId: bigint): Promise<Hex> {
    this.state = "funded";
    return Promise.resolve(this.send(`${jobId.toString()}:fund`));
  }

  public submit(jobId: bigint): Promise<Hex> {
    this.state = "submitted";
    return Promise.resolve(this.send(`${jobId.toString()}:submit`));
  }

  public complete(jobId: bigint): Promise<Hex> {
    this.state = "completed";
    return Promise.resolve(this.send(`${jobId.toString()}:complete`));
  }

  public reject(jobId: bigint): Promise<Hex> {
    this.state = "rejected";
    return Promise.resolve(this.send(`${jobId.toString()}:reject`));
  }

  public claimRefund(jobId: bigint): Promise<Hex> {
    this.state = "expired";
    return Promise.resolve(this.send(`${jobId.toString()}:claimRefund`));
  }

  public getJob(jobId: bigint): Promise<JobView> {
    const job = [...this.jobs.values()].find((j) => j.id === jobId);
    if (job === undefined) throw new Error(`no such job: ${jobId.toString()}`);
    return Promise.resolve({ ...job, status: this.state });
  }

  public getJobState(): Promise<JobState> {
    return Promise.resolve(this.state);
  }

  public getFeeRates(): Promise<JobFeeRates> {
    return Promise.resolve({ platformFeeBP: 250n, evaluatorFeeBP: 100n });
  }

  /** 计数用：真正"发出去"的交易数。 */
  public get sentCount(): number {
    return this.writes.length;
  }

  private send(key: string): Hex {
    const existing = this.sent.get(key);
    if (existing !== undefined) return existing;
    const txHash = `0x${(this.sent.size + 1).toString(16).padStart(4, "0")}${"ee".repeat(30)}` as Hex;
    this.sent.set(key, txHash);
    this.writes.push(key);
    return txHash;
  }
}

function fakeX402(): X402Client & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check: (moduleId): Promise<ModuleCheckResult> => {
      calls.push(moduleId);
      return Promise.resolve({
        response: moduleResponse(),
        settlementId: "gw-1",
        paidAtomic: usdc6FromDecimal("0.80"),
      });
    },
  };
}

function wire(verdict: string, grayType: string): Record<string, unknown> {
  return {
    item_id: "MT-01",
    verdict,
    confidence: "high",
    source_refs: ["31 CFR § 1010.100(ff)"],
    risk_flags: [],
    gray_type: grayType,
  };
}

interface Harness {
  readonly db: EngineDatabase;
  readonly stores: CaseStores;
  readonly jobClient: FakeJobClient;
  readonly x402: ReturnType<typeof fakeX402>;
  readonly verifyCalls: { count: number };
  readonly deps: RunCaseDeps;
}

function harness(options: { readonly verdict?: string; readonly passed?: boolean } = {}): Harness {
  const db = openDatabase(":memory:");
  const stores: CaseStores = {
    cases: new CaseStore(db),
    ledger: new LedgerStore(db),
    runs: new CaseRunStore(db),
    purchases: new PurchaseStore(db),
  };
  const jobClient = new FakeJobClient();
  const x402 = fakeX402();
  const verifyCalls = { count: 0 };
  const verdict = options.verdict ?? "confirmed_exempt";
  const passed = options.passed ?? true;

  const report: VerificationReportView = {
    passed,
    reasonHash: REASON_HASH,
    outcomes: [{ check: "deliverable_signature", passed, failures: [] }],
  };

  const deps: RunCaseDeps = {
    jobClient,
    stores,
    x402,
    adjudicator: {
      llm: new FakeAdjudicatorLLM({
        fallbackWire: wire(verdict, verdict === "gray_interpretive" ? "interpretive" : "none"),
      }),
      cache: new InMemoryGoldenCache(),
      mode: "live",
    },
    operatorAccount: privateKeyToAccount(DEMO_KEY),
    verify: () => {
      verifyCalls.count += 1;
      return Promise.resolve(report);
    },
    settle: async ({ jobId }) => {
      const txHash = passed ? await jobClient.complete(jobId) : await jobClient.reject(jobId);
      return { action: passed ? "complete" : "reject", txHash };
    },
  };

  return { db, stores, jobClient, x402, verifyCalls, deps };
}

function request(over: Partial<CaseRequest> = {}): CaseRequest {
  return {
    caseId: "citely-demo-0001",
    deal: {
      deal_id: "citely-demo-0001",
      activity: "payments",
      parties: [{ role: "payer", jurisdiction: "US" }],
      evidence: { note: "counterparty is licensed" },
    } as unknown as CaseRequest["deal"],
    rubric: RUBRIC,
    module: { id: "us-msb", quotedPriceAtomic: usdc6FromDecimal("0.80") },
    job: {
      provider: PROVIDER,
      evaluator: EVALUATOR,
      expiredAt: JOB_EXPIRED_AT,
      budgetAtomic: usdc6FromDecimal("3.00"),
    },
    settlement: { party: "payee", payee: PAYEE, amountAtomic: usdc6FromDecimal("12.50") },
    chainId: 10143,
    ...over,
  };
}

describe("runCase", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("跑通全流程并返回签名 SA、三检结论、收口动作与账本", async () => {
    const result = await runCase(request(), h.deps);

    expect(result.replayed).toBe(false);
    expect(result.jobId).toBe(7n);
    expect(result.saHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.sa.attestation.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(result.routing.exit).toBe("high_confidence");
    expect(result.verification.passed).toBe(true);
    expect(result.settlement?.action).toBe("complete");
    expect(result.procurement).toEqual({ settlementId: "gw-1", paidAtomic: "800000", reused: false });
    // 案件费两行（operator/verifier）+ 采购两行（module_fee/royalty）
    expect(result.ledger).toHaveLength(4);
    expect(h.stores.cases.getCase("citely-demo-0001").state).toBe("settled");
  });

  it("SA 的 expires_at 取自链上回读，legs 的 condition 只由 Module 结果推导", async () => {
    const result = await runCase(request(), h.deps);

    expect(result.sa.bound_to.expires_at).toBe(new Date(Number(JOB_EXPIRED_AT) * 1000).toISOString());
    // Module overall=HOLD 且 blocked_check_ids 非空 → HOLD，与判定器给的
    // confirmed_exempt 无关（不变量 2）。
    expect(result.sa.legs[0]?.condition).toBe("HOLD");
    expect(result.sa.legs[0]?.basis[0]?.verdict).toBe("confirmed_exempt");
  });

  it("同一请求重发：不重复建 Job、不重复付费、不重复入账，sa_hash 不变", async () => {
    const first = await runCase(request(), h.deps);
    const writesAfterFirst = [...h.jobClient.writes];

    const second = await runCase(request(), h.deps);

    expect(second.replayed).toBe(true);
    expect(second.saHash).toBe(first.saHash);
    expect(second.jobId).toBe(first.jobId);
    // 三条断言分别对应三层幂等。
    expect(h.jobClient.writes).toEqual(writesAfterFirst);
    expect(h.x402.calls).toEqual(["us-msb"]);
    expect(second.ledger).toHaveLength(first.ledger.length);
    // 重放不该再跑三检——它是花时间的外部调用。
    expect(h.verifyCalls.count).toBe(1);
  });

  it("并发重发同一个案件：只有一份真跑，其余走重放", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, async () => await runCase(request(), h.deps)));

    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.saHash)).size).toBe(1);
    expect(h.x402.calls).toEqual(["us-msb"]);
    expect(h.jobClient.writes.filter((w) => w.endsWith(":createJob"))).toHaveLength(1);
  });

  it("并发不同案件：互不阻塞、各自建各自的 Job", async () => {
    const results = await Promise.all([
      runCase(request({ caseId: "case-a" }), h.deps),
      runCase(request({ caseId: "case-b" }), h.deps),
    ]);

    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(new Set(results.map((r) => r.jobId.toString())).size).toBe(2);
    expect(h.x402.calls).toHaveLength(2);
  });

  it("同 caseId 换了请求参数 → 冲突，绝不用新参数覆盖既有案件", async () => {
    await runCase(request(), h.deps);

    await expect(
      runCase(request({ settlement: { party: "payee", payee: PAYEE, amountAtomic: usdc6FromDecimal("99.00") } }), h.deps),
    ).rejects.toThrow(CaseRequestConflictError);
  });

  it("受理失败（出口 1）：响亮失败且**一笔链上写都不发**", async () => {
    const broken = request({ rubric: { ...RUBRIC, rubric: { ...RUBRIC.rubric, items: [] } } });

    await expect(runCase(broken, h.deps)).rejects.toThrow(IntakeRejectedError);
    expect(h.jobClient.writes).toEqual([]);
    expect(h.x402.calls).toEqual([]);
    expect(h.stores.runs.get("citely-demo-0001").status).toBe("failed");
  });

  it("三检不过 → reject 收口，且不记 complete 的案件费拆分（只留采购行）", async () => {
    const failing = harness({ passed: false });
    const result = await runCase(request(), failing.deps);

    expect(result.settlement?.action).toBe("reject");
    expect(result.ledger.map((e) => e.category).sort()).toEqual(["module_fee", "royalty"]);
    expect(failing.stores.cases.getCase("citely-demo-0001").state).toBe("rejected");
  });

  it("出口 4（解释性 gray）：卷宗与 Review Job 模板随 SA 一起产出", async () => {
    const gray = harness({ verdict: "gray_interpretive" });
    const result = await runCase(
      request({
        escalation: {
          client: CLIENT,
          provider: PROVIDER,
          evaluator: EVALUATOR,
          expiresAt: new Date("2026-12-31T00:00:00.000Z"),
          deposit: usdc6FromDecimal("2.00"),
        },
      }),
      gray.deps,
    );

    expect(result.routing.exit).toBe("interpretive_gray");
    expect(result.sa.legs[0]?.escalation?.briefing_pack_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.briefingPack?.facts.items[0]?.item_id).toBe("MT-01");
    // 卷宗是陈述材料：不含 PASS/HOLD/ESCALATE 的改判空间。
    expect(result.briefingPack?.narrative).toBeNull();
  });

  it("命中出口 4 却没给升级配置 → 响亮失败，不产出半成品 SA", async () => {
    const gray = harness({ verdict: "gray_interpretive" });
    await expect(runCase(request(), gray.deps)).rejects.toThrow(EscalationConfigMissingError);
  });

  it("中途失败留痕并原样抛出；重试接管后不重复付费、不重复建 Job", async () => {
    const flaky = harness();
    let failNext = true;
    const deps: RunCaseDeps = {
      ...flaky.deps,
      verify: (req) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("verifier unavailable"));
        }
        return flaky.deps.verify(req);
      },
    };

    await expect(runCase(request(), deps)).rejects.toThrow("verifier unavailable");
    expect(flaky.stores.runs.get("citely-demo-0001").status).toBe("failed");

    const retried = await runCase(request(), deps);
    expect(retried.replayed).toBe(false);
    expect(retried.settlement?.action).toBe("complete");
    // 第一次已经付过款、建过 Job，重试不许再来一遍。
    expect(flaky.x402.calls).toEqual(["us-msb"]);
    expect(flaky.jobClient.writes.filter((w) => w.endsWith(":createJob"))).toHaveLength(1);
    expect(retried.ledger).toHaveLength(4);
  });
});
