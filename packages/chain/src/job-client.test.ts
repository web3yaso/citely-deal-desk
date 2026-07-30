import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { beforeEach, describe, expect, it } from "vitest";

import { agenticCommerceAbi } from "./abi/agentic-commerce.js";
import { ChainError } from "./errors.js";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import {
  createJobClient,
  DEMO_EXPIRY_SECONDS,
  expiryFromNow,
  MIN_EXPIRY_SECONDS,
  splitFees,
  toJobState,
  type JobRoleWallets,
} from "./job-client.js";

const JOB_CONTRACT = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0x2222222222222222222222222222222222222222" as const;
const CLIENT_ADDR = "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1" as const;
const PROVIDER_ADDR = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as const;
const EVALUATOR_ADDR = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1" as const;
const TX = `0x${"ab".repeat(32)}` as Hex;
const DELIVERABLE = `0x${"cd".repeat(32)}` as Hex;

interface WriteCall {
  readonly role: keyof JobRoleWallets;
  readonly address: Address;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

interface ReadRequest {
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

interface ChainStub {
  status: number;
  budget: bigint;
  expiredAt: bigint;
  allowance: bigint;
  blockTimestamp: bigint;
  receiptStatus: "success" | "reverted";
}

function makeJobCreatedLog(jobId: bigint) {
  return {
    address: JOB_CONTRACT,
    topics: encodeEventTopics({
      abi: agenticCommerceAbi,
      eventName: "JobCreated",
      args: { jobId, client: CLIENT_ADDR, provider: PROVIDER_ADDR },
    }),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }],
      [EVALUATOR_ADDR, 1n, "0x0000000000000000000000000000000000000000"],
    ),
  };
}

function makeHarness(overrides: Partial<ChainStub> = {}) {
  const stub: ChainStub = {
    status: 0,
    budget: 1_000_000n,
    expiredAt: 2_000n,
    allowance: 0n,
    blockTimestamp: 1_000n,
    receiptStatus: "success",
    ...overrides,
  };
  const writes: WriteCall[] = [];

  const publicClient = {
    readContract: async (req: ReadRequest): Promise<unknown> => {
      switch (req.functionName) {
        case "getJob":
          return {
            id: 42n,
            client: CLIENT_ADDR,
            provider: PROVIDER_ADDR,
            evaluator: EVALUATOR_ADDR,
            description: "case",
            budget: stub.budget,
            expiredAt: stub.expiredAt,
            status: stub.status,
            hook: "0x0000000000000000000000000000000000000000",
          };
        case "allowance":
          return stub.allowance;
        case "platformFeeBP":
          return 250n;
        case "evaluatorFeeBP":
          return 100n;
        default:
          throw new Error(`未预期的读调用：${req.functionName}`);
      }
    },
    waitForTransactionReceipt: async () => ({ status: stub.receiptStatus }),
    getTransactionReceipt: async () => ({ logs: [makeJobCreatedLog(42n)] }),
    getBlock: async () => ({ timestamp: stub.blockTimestamp }),
  };

  const wallet = (role: keyof JobRoleWallets, address: Address) => ({
    account: { address },
    writeContract: async (call: {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    }): Promise<Hex> => {
      writes.push({ role, address: call.address, functionName: call.functionName, args: call.args });
      return TX;
    },
  });

  const wallets = {
    client: wallet("client", CLIENT_ADDR),
    provider: wallet("provider", PROVIDER_ADDR),
    evaluator: wallet("evaluator", EVALUATOR_ADDR),
  } as unknown as JobRoleWallets;

  const store = new InMemoryIdempotencyStore();
  const client = createJobClient({
    jobContract: JOB_CONTRACT,
    usdc: USDC,
    publicClient: publicClient as unknown as PublicClient<Transport, Chain>,
    wallets,
    store,
  });
  return { client, store, writes, stub };
}

describe("toJobState", () => {
  it("六态逐个映射，uint8=5 是 expired", () => {
    expect([0, 1, 2, 3, 4, 5].map(toJobState)).toEqual([
      "open",
      "funded",
      "submitted",
      "completed",
      "rejected",
      "expired",
    ]);
  });

  it("未知取值抛错而不是猜", () => {
    expect(() => toJobState(6)).toThrow(ChainError);
    expect(() => toJobState(6)).toThrow(/未知的链上 JobStatus=6/);
  });
});

describe("splitFees（§2.4 净额）", () => {
  it("按链上费率算 net / platformFee / evalFee", () => {
    expect(splitFees(1_000_000n, { platformFeeBP: 250n, evaluatorFeeBP: 100n })).toEqual({
      platformFee: 25_000n,
      evaluatorFee: 10_000n,
      net: 965_000n,
    });
  });

  it("零费率时 net 等于 budget", () => {
    expect(splitFees(800_000n, { platformFeeBP: 0n, evaluatorFeeBP: 0n }).net).toBe(800_000n);
  });
});

describe("角色钱包隔离（§2.1）", () => {
  let harness: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("createJob 用 client 钱包，hook 传零地址", async () => {
    const result = await harness.client.createJob({
      provider: PROVIDER_ADDR,
      evaluator: EVALUATOR_ADDR,
      expiredAt: 9_999n,
      description: "case-1",
      caseId: "case-1",
    });
    expect(result).toEqual({ jobId: 42n, txHash: TX });
    expect(harness.writes[0]?.role).toBe("client");
    expect(harness.writes[0]?.args[4]).toBe("0x0000000000000000000000000000000000000000");
    await expect(harness.store.lookup("case-1:createJob")).resolves.not.toBeNull();
  });

  it("setBudget 用 provider 钱包并传空 optParams", async () => {
    await expect(harness.client.setBudget(42n, 1_000_000n)).resolves.toBe(TX);
    expect(harness.writes[0]?.role).toBe("provider");
    expect(harness.writes[0]?.args).toEqual([42n, 1_000_000n, "0x"]);
  });

  it("submit 用 provider 钱包", async () => {
    await harness.client.submit(42n, DELIVERABLE);
    expect(harness.writes[0]?.role).toBe("provider");
  });

  it("complete 用 evaluator 钱包", async () => {
    const h = makeHarness({ status: 2 });
    await h.client.complete(42n, DELIVERABLE);
    expect(h.writes[0]?.role).toBe("evaluator");
    expect(h.writes[0]?.args).toEqual([42n, DELIVERABLE, "0x"]);
  });

  it("三角色共用同一地址时拒绝构造", () => {
    const wallets = {
      client: { account: { address: CLIENT_ADDR } },
      provider: { account: { address: CLIENT_ADDR } },
      evaluator: { account: { address: EVALUATOR_ADDR } },
    } as unknown as JobRoleWallets;
    expect(() =>
      createJobClient({
        jobContract: JOB_CONTRACT,
        usdc: USDC,
        publicClient: {} as unknown as PublicClient<Transport, Chain>,
        wallets,
        store: new InMemoryIdempotencyStore(),
      }),
    ).toThrow(/物理分离/);
  });
});

describe("fund（§2.5 抢跑缓解 + approve）", () => {
  it("链上 budget 与预期不符时中止，且一笔交易都不发", async () => {
    const h = makeHarness({ budget: 2_000_000n });
    await expect(h.client.fund(42n, 1_000_000n)).rejects.toThrow(/疑似抢跑/);
    expect(h.writes).toHaveLength(0);
    expect(h.store.size).toBe(0);
  });

  it("预期一致时先 approve 再 fund，两笔顺序固定", async () => {
    const h = makeHarness({ allowance: 0n });
    await expect(h.client.fund(42n, 1_000_000n)).resolves.toBe(TX);
    expect(h.writes.map((w) => [w.role, w.functionName])).toEqual([
      ["client", "approve"],
      ["client", "fund"],
    ]);
    expect(h.writes[0]?.args).toEqual([JOB_CONTRACT, 1_000_000n]);
  });

  it("已有足额 allowance 时跳过 approve", async () => {
    const h = makeHarness({ allowance: 5_000_000n });
    await h.client.fund(42n, 1_000_000n);
    expect(h.writes.map((w) => w.functionName)).toEqual(["fund"]);
  });

  it("非 Open 态拒绝 fund", async () => {
    const h = makeHarness({ status: 1 });
    await expect(h.client.fund(42n, 1_000_000n)).rejects.toThrow(/要求 Job 处于 open 态/);
    expect(h.writes).toHaveLength(0);
  });
});

describe("状态授权矩阵（§2.3）", () => {
  it("complete 只允许 Submitted", async () => {
    for (const status of [0, 1, 3, 4, 5]) {
      const h = makeHarness({ status });
      await expect(h.client.complete(42n, DELIVERABLE)).rejects.toThrow(/要求 Job 处于 submitted/);
      expect(h.writes).toHaveLength(0);
    }
  });

  it("reject 允许 Funded 与 Submitted 两态", async () => {
    for (const status of [1, 2]) {
      const h = makeHarness({ status });
      await expect(h.client.reject(42n, DELIVERABLE)).resolves.toBe(TX);
      expect(h.writes[0]?.role).toBe("evaluator");
    }
  });

  it("reject 在 Open 态由本客户端拒绝（Open 态是 client 的早退路径，不走 evaluator）", async () => {
    const h = makeHarness({ status: 0 });
    await expect(h.client.reject(42n, DELIVERABLE)).rejects.toThrow(
      /要求 Job 处于 funded\|submitted/,
    );
  });

  it("claimRefund 未到期时中止", async () => {
    const h = makeHarness({ status: 1, expiredAt: 2_000n, blockTimestamp: 1_999n });
    await expect(h.client.claimRefund(42n)).rejects.toThrow(/尚未到期/);
    expect(h.writes).toHaveLength(0);
  });

  it("claimRefund 到期后由 client 钱包发起", async () => {
    const h = makeHarness({ status: 1, expiredAt: 2_000n, blockTimestamp: 2_000n });
    await expect(h.client.claimRefund(42n)).resolves.toBe(TX);
    expect(h.writes[0]?.role).toBe("client");
    expect(h.writes[0]?.functionName).toBe("claimRefund");
  });
});

describe("幂等", () => {
  it("同一 jobId+action 第二次调用不再发交易", async () => {
    const h = makeHarness();
    await h.client.setBudget(42n, 1_000_000n);
    await expect(h.client.setBudget(42n, 1_000_000n)).resolves.toBe(TX);
    expect(h.writes).toHaveLength(1);
  });

  it("fund 命中既有记录时连链上预读都不做", async () => {
    const h = makeHarness({ budget: 2_000_000n });
    await h.store.record({ key: "42:fund", txHash: TX, submittedAt: "2026-07-28T00:00:00.000Z" });
    // budget 与预期不符本会报错，命中幂等记录后应直接返回既有 txHash。
    await expect(h.client.fund(42n, 1_000_000n)).resolves.toBe(TX);
    expect(h.writes).toHaveLength(0);
  });

  it("不同 action 各自独立", async () => {
    const h = makeHarness();
    await h.client.setBudget(42n, 1_000_000n);
    await h.client.submit(42n, DELIVERABLE);
    expect(h.writes.map((w) => w.functionName)).toEqual(["setBudget", "submit"]);
  });
});

describe("失败与读取", () => {
  it("交易 revert 时抛出带 txHash 的 ChainError", async () => {
    const h = makeHarness({ receiptStatus: "reverted" });
    try {
      await h.client.setBudget(42n, 1_000_000n);
      expect.unreachable("应当抛错");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ChainError);
      expect((error as ChainError).context.txHash).toBe(TX);
      expect((error as ChainError).context.action).toBe("setBudget");
    }
  });

  it("setBudget 金额非正时直接拒绝", async () => {
    const h = makeHarness();
    await expect(h.client.setBudget(42n, 0n)).rejects.toThrow(/必须为正/);
  });

  it("getJobState 映射链上 uint8", async () => {
    const h = makeHarness({ status: 5 });
    await expect(h.client.getJobState(42n)).resolves.toBe("expired");
  });

  it("getFeeRates 读链上费率，不硬编码", async () => {
    const h = makeHarness();
    await expect(h.client.getFeeRates()).resolves.toEqual({
      platformFeeBP: 250n,
      evaluatorFeeBP: 100n,
    });
  });
});

describe("expiryFromNow（5 分钟下限，别拿 gas 去换 ExpiryTooShort）", () => {
  const NOW = 1_800_000_000n;

  it("合法值返回绝对 expiredAt", () => {
    expect(expiryFromNow(600n, NOW)).toBe(NOW + 600n);
    expect(expiryFromNow(DEMO_EXPIRY_SECONDS, NOW)).toBe(NOW + 600n);
  });

  it("下限是严格大于 300 秒，且本地再留 30 秒出块漂移余量", () => {
    expect(MIN_EXPIRY_SECONDS).toBe(300n);
    expect(() => expiryFromNow(300n, NOW)).toThrow(/过短/);
    expect(() => expiryFromNow(329n, NOW)).toThrow(/至少 330 秒/);
    expect(expiryFromNow(330n, NOW)).toBe(NOW + 330n);
  });

  it("演示缺省值是 10 分钟，不是 24 小时（现场等不到一天）", () => {
    expect(DEMO_EXPIRY_SECONDS).toBe(600n);
  });
});
