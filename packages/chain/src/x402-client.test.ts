import { afterEach, describe, expect, it } from "vitest";

import { clearRegisteredSecrets, registerSecret } from "./config/redact.js";
import { ChainError } from "./errors.js";
import type { DealInput } from "./types/module.js";
import {
  ARC_TESTNET_GATEWAY_WALLET,
  ARC_TESTNET_USDC,
  createX402Client,
  MINIMUM_GATEWAY_BALANCE,
  parseUsdcAmount,
  waitForGatewayDeposit,
  type GatewayLike,
  type GatewayPayResult,
} from "./x402-client.js";

const BASE_URL = "https://msb-agent.example";

const DEAL_INPUT: DealInput = {
  deal_id: "case-1",
  parties: [
    { role: "payer", country: "US", state: "NY" },
    { role: "payee", country: "SG" },
  ],
  activity: "money_transmission",
  amount_usdc: 10_000,
  evidence: {},
};

const OK_RESPONSE = {
  module: "us-msb",
  version: "2026.07.1",
  updated_at: "2026-07-01T00:00:00",
  maintainer_wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  royalty_bps: 500,
  checks: [{ id: "c1", result: "PASS", reason: "ok", source: "https://example.gov" }],
  overall: "PASS",
  settlement_constraints: {
    module: "us-msb",
    module_version: "2026.07.1",
    deal_id: "case-1",
    valid_until: "2026-08-01T00:00:00",
    blocked_check_ids: [],
    escalated_check_ids: [],
    evidence_hash: "a".repeat(64),
  },
  evidence_hash: "a".repeat(64),
  disclaimer: "不构成法律意见",
};

interface StubOptions {
  readonly available?: bigint;
  readonly result?: GatewayPayResult;
  readonly payError?: Error;
}

function makeGateway(options: StubOptions = {}) {
  const calls: { url: string; body: unknown; method?: string }[] = [];
  const gateway: GatewayLike = {
    address: "0x1111111111111111111111111111111111111111",
    getBalances: async () => ({
      gateway: {
        available: options.available ?? 2_000_000n,
        formattedAvailable: ((Number(options.available ?? 2_000_000n) / 1e6).toFixed(2)),
      },
    }),
    pay: async (url, opts) => {
      calls.push({ url, body: opts.body, ...(opts.method === undefined ? {} : { method: opts.method }) });
      if (options.payError !== undefined) {
        throw options.payError;
      }
      return options.result ?? { status: 200, data: OK_RESPONSE, transaction: "settle-1" };
    },
  };
  return { gateway, calls };
}

afterEach(() => {
  clearRegisteredSecrets();
});

describe("createX402Client.check", () => {
  it("成功路径：POST 到 /modules/:id/check，body 是对象", async () => {
    const { gateway, calls } = makeGateway();
    const client = createX402Client({ baseUrl: `${BASE_URL}/`, gateway });

    const response = await client.check("us-msb", DEAL_INPUT);

    expect(calls[0]?.url).toBe(`${BASE_URL}/modules/us-msb/check`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual(DEAL_INPUT);
    expect(typeof calls[0]?.body).toBe("object");
    expect(response.overall).toBe("PASS");
    expect(response.settlement_constraints.deal_id).toBe("case-1");
  });

  it("余额不足抛可读错误，且不发起付款、不自动 deposit", async () => {
    const { gateway, calls } = makeGateway({ available: MINIMUM_GATEWAY_BALANCE - 1n });
    const client = createX402Client({ baseUrl: BASE_URL, gateway });

    await expect(client.check("us-msb", DEAL_INPUT)).rejects.toThrow(/Gateway 可用余额不足/);
    await expect(client.check("us-msb", DEAL_INPUT)).rejects.toThrow(/本客户端不会自动存款/);
    expect(calls).toHaveLength(0);
  });

  it("非 200 时抛错并带上响应体", async () => {
    const { gateway } = makeGateway({
      result: { status: 402, data: { error: "unpaid" }, transaction: "" },
    });
    const client = createX402Client({ baseUrl: BASE_URL, gateway });
    await expect(client.check("us-msb", DEAL_INPUT)).rejects.toThrow(/应返回 200，实际 402/);
  });

  it("结算 ID 为空视为付款失败", async () => {
    const { gateway } = makeGateway({
      result: { status: 200, data: OK_RESPONSE, transaction: "" },
    });
    const client = createX402Client({ baseUrl: BASE_URL, gateway });
    await expect(client.check("us-msb", DEAL_INPUT)).rejects.toThrow(/缺少结算 ID/);
  });

  it("响应形状不合法时点名字段", async () => {
    const { gateway } = makeGateway({
      result: {
        status: 200,
        data: { ...OK_RESPONSE, overall: "MAYBE" },
        transaction: "settle-1",
      },
    });
    const client = createX402Client({ baseUrl: BASE_URL, gateway });
    await expect(client.check("us-msb", DEAL_INPUT)).rejects.toThrow(/overall 取值非法：MAYBE/);
  });

  it("module 与请求不一致时中止", async () => {
    const { gateway } = makeGateway({
      result: {
        status: 200,
        data: { ...OK_RESPONSE, module: "sg-msb" },
        transaction: "settle-1",
      },
    });
    const client = createX402Client({ baseUrl: BASE_URL, gateway });
    await expect(client.check("us-msb", DEAL_INPUT)).rejects.toThrow(
      /module=sg-msb 与请求的 us-msb 不一致/,
    );
  });

  it("deal_id 与请求不一致时中止", async () => {
    const { gateway } = makeGateway({
      result: {
        status: 200,
        data: {
          ...OK_RESPONSE,
          settlement_constraints: { ...OK_RESPONSE.settlement_constraints, deal_id: "other" },
        },
        transaction: "settle-1",
      },
    });
    const client = createX402Client({ baseUrl: BASE_URL, gateway });
    await expect(client.check("us-msb", DEAL_INPUT)).rejects.toThrow(/deal_id=other/);
  });

  it("付款抛错时包成 ChainError，且已登记的私钥不会泄漏", async () => {
    const fakeKey = `0x${"a".repeat(64)}`;
    registerSecret(fakeKey);
    const { gateway } = makeGateway({
      payError: new Error(`signing failed with key ${fakeKey}`),
    });
    const client = createX402Client({ baseUrl: BASE_URL, gateway });

    try {
      await client.check("us-msb", DEAL_INPUT);
      expect.unreachable("应当抛错");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ChainError);
      const { message } = error as ChainError;
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain("aaaa");
      expect((error as ChainError).cause).toBeInstanceOf(Error);
    }
  });
});

describe("Arc Testnet 地址常量", () => {
  it("USDC 与 Gateway Wallet 取自 SDK 内置配置", () => {
    expect(ARC_TESTNET_USDC).toBe("0x3600000000000000000000000000000000000000");
    expect(ARC_TESTNET_GATEWAY_WALLET).toBe("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
  });
});

describe("parseUsdcAmount", () => {
  it("按 6 位小数换算，不碰浮点", () => {
    expect(parseUsdcAmount("1.5")).toBe(1_500_000n);
    expect(parseUsdcAmount("0.000001")).toBe(1n);
    expect(parseUsdcAmount("1234")).toBe(1_234_000_000n);
    expect(parseUsdcAmount("  2.05  ")).toBe(2_050_000n);
  });

  it("拒绝 0、负数、超过 6 位小数与非数字", () => {
    expect(() => parseUsdcAmount("0")).toThrow(/必须大于 0/);
    expect(() => parseUsdcAmount("-1")).toThrow(/最多 6 位小数/);
    expect(() => parseUsdcAmount("1.1234567")).toThrow(/最多 6 位小数/);
    expect(() => parseUsdcAmount("abc")).toThrow(/最多 6 位小数/);
    expect(() => parseUsdcAmount("")).toThrow(/最多 6 位小数/);
  });
});

describe("waitForGatewayDeposit", () => {
  function balanceSource(sequence: readonly bigint[]) {
    let index = 0;
    return {
      calls: () => index,
      source: {
        getBalances: async () => {
          const available = sequence[Math.min(index, sequence.length - 1)] ?? 0n;
          index += 1;
          return { gateway: { available, formattedAvailable: available.toString() } };
        },
      },
    };
  }

  it("到账后立刻返回，并逐次回报进度", async () => {
    const { source, calls } = balanceSource([0n, 500_000n, 1_500_000n]);
    const progress: bigint[] = [];
    const available = await waitForGatewayDeposit(source, 1_500_000n, {
      intervalMs: 0,
      maxAttempts: 24,
      onProgress: (_attempt, _max, current) => progress.push(current),
    });
    expect(available).toBe(1_500_000n);
    expect(progress).toEqual([0n, 500_000n, 1_500_000n]);
    expect(calls()).toBe(3);
  });

  it("超时抛出说清等了多久的错误，并说明资金没丢", async () => {
    const { source } = balanceSource([0n]);
    await expect(
      waitForGatewayDeposit(source, 1_000_000n, { intervalMs: 0, maxAttempts: 3 }),
    ).rejects.toThrow(/存款等待超时[\s\S]*资金没有丢/);
  });
});
