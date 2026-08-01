import type { Address, Chain, PublicClient, Transport } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { clearRegisteredSecrets } from "./config/redact.js";
import {
  checkOpenAiApiKey,
  checkOpenAiModel,
  checkPrivateKeyFormat,
  checkReviewExpertWallet,
  REVIEW_EXPERT_GAS_NOTE,
  deriveAddress,
  describeBalances,
  formatCheckLine,
  condenseErrorMessage,
  formatUsdc,
  pendingCheck,
  runCheck,
  summarize,
  type HealthCheckLine,
} from "./diagnostics.js";

// 全 a 的假私钥：格式合法但不对应任何有资金的账户。
const FAKE_KEY = `0x${"a".repeat(64)}`;

afterEach(() => {
  clearRegisteredSecrets();
});

describe("formatCheckLine / summarize", () => {
  it("三态分别渲染 ✅ / ❌ / ⏳", () => {
    expect(formatCheckLine({ name: "RPC", status: "ok", detail: "chainId 5042002" })).toBe(
      "✅ RPC — chainId 5042002",
    );
    expect(formatCheckLine({ name: "RPC", status: "fail", detail: "超时" })).toBe("❌ RPC — 超时");
    expect(formatCheckLine(pendingCheck("JOB_CONTRACT_ADDRESS", "等 spike ①"))).toBe(
      "⏳ JOB_CONTRACT_ADDRESS — 等 spike ①",
    );
  });

  it("汇总三态条数，⏳ 不算失败", () => {
    const lines: HealthCheckLine[] = [
      { name: "a", status: "ok", detail: "" },
      { name: "b", status: "fail", detail: "" },
      { name: "c", status: "pending", detail: "" },
    ];
    expect(summarize(lines)).toEqual({ passed: 1, failed: 1, pending: 1, ok: false });
    expect(
      summarize([
        { name: "a", status: "ok", detail: "" },
        pendingCheck("b", "等上游"),
      ]).ok,
    ).toBe(true);
  });
});

describe("runCheck", () => {
  it("成功时返回 ✅ 与说明", async () => {
    await expect(runCheck("X", () => "好了")).resolves.toEqual({
      name: "X",
      status: "ok",
      detail: "好了",
    });
  });

  it("抛错时转成 ❌ 而不是中断整张单子", async () => {
    const line = await runCheck("X", () => {
      throw new Error("连不上");
    });
    expect(line).toEqual({ name: "X", status: "fail", detail: "连不上" });
  });

  it("错误消息里的已登记密钥被脱敏", async () => {
    checkPrivateKeyFormat({ K: FAKE_KEY }, "K");
    const line = await runCheck("X", () => {
      throw new Error(`boom ${FAKE_KEY}`);
    });
    expect(line.detail).toBe("boom [REDACTED]");
  });
});

describe("checkReviewExpertWallet", () => {
  const VAR = "REVIEW_EXPERT_PRIVATE_KEY";

  it("未设置时 ⏳ 且说明只有出口 4 需要它", async () => {
    const line = await checkReviewExpertWallet({}, VAR, () => Promise.resolve(0n));
    expect(line.status).toBe("pending");
    expect(line.detail).toContain("出口 4");
    expect(line.detail).toContain(".env.example");
  });

  it("有余额时 ✅ 回报地址与原生币余额，不回显私钥", async () => {
    const line = await checkReviewExpertWallet({ [VAR]: FAKE_KEY }, VAR, () =>
      Promise.resolve(1_500_000_000_000_000_000n),
    );
    expect(line.status).toBe("ok");
    expect(line.detail).toMatch(/^0x[0-9a-fA-F]{40} 原生 1\.5$/);
    expect(line.detail).not.toContain("aaaa");
  });

  it("余额为 0 时 ⏳ 不报红，并说明专家通常不需要 gas", async () => {
    const line = await checkReviewExpertWallet({ [VAR]: FAKE_KEY }, VAR, () => Promise.resolve(0n));
    expect(line.status).toBe("pending");
    expect(line.detail).toContain(REVIEW_EXPERT_GAS_NOTE);
  });

  it("格式非法时 ❌ 且不回显值", async () => {
    const line = await checkReviewExpertWallet({ [VAR]: "0xdead" }, VAR, () => Promise.resolve(0n));
    expect(line.status).toBe("fail");
    expect(line.detail).toContain(`${VAR} 格式非法`);
    expect(line.detail).not.toContain("dead");
  });

  it("查余额失败时 ❌", async () => {
    const line = await checkReviewExpertWallet({ [VAR]: FAKE_KEY }, VAR, () =>
      Promise.reject(new Error("request limit reached")),
    );
    expect(line.status).toBe("fail");
    expect(line.detail).toContain("request limit reached");
  });
});

describe("checkPrivateKeyFormat", () => {
  it("合法私钥只回报地址，不回显私钥", () => {
    const line = checkPrivateKeyFormat({ OPERATOR_PRIVATE_KEY: FAKE_KEY }, "OPERATOR_PRIVATE_KEY");
    expect(line.status).toBe("ok");
    expect(line.detail).toMatch(/^格式合法，地址 0x[0-9a-fA-F]{40}$/);
    expect(line.detail).not.toContain("aaaa");
  });

  it("缺失时 ❌ 且点名变量", () => {
    const line = checkPrivateKeyFormat({}, "VERIFIER_PRIVATE_KEY");
    expect(line.status).toBe("fail");
    expect(line.detail).toContain("VERIFIER_PRIVATE_KEY 缺失");
  });

  it("格式非法时 ❌ 且不回显值", () => {
    const line = checkPrivateKeyFormat({ K: `0x${"a".repeat(63)}` }, "K");
    expect(line.status).toBe("fail");
    expect(line.detail).not.toContain("aaaa");
  });
});

describe("OpenAI 两项", () => {
  it("API key 只报是否设置", () => {
    expect(checkOpenAiApiKey({ OPENAI_API_KEY: "sk-secret-value" })).toEqual({
      name: "OPENAI_API_KEY",
      status: "ok",
      detail: "已设置（值不打印）",
    });
    expect(checkOpenAiApiKey({ OPENAI_API_KEY: "  " }).status).toBe("fail");
  });

  it("API key 的值绝不出现在输出里", () => {
    const line = checkOpenAiApiKey({ OPENAI_API_KEY: "sk-secret-value" });
    expect(formatCheckLine(line)).not.toContain("sk-secret");
  });

  it("模型必须是带日期 snapshot", () => {
    expect(checkOpenAiModel({ OPENAI_MODEL: "gpt-5.6-luna-2026-05-13" }).status).toBe("ok");
    expect(checkOpenAiModel({ OPENAI_MODEL: "gpt-5.6-luna" }).status).toBe("fail");
    // 没设置 ≠ 设错了：等 spike ⑨ 的项标 ⏳，别让用户去修一个还没到时候的东西。
    expect(checkOpenAiModel({}).status).toBe("pending");
    expect(checkOpenAiModel({}).detail).toContain("spike ⑨");
  });
});

describe("condenseErrorMessage", () => {
  it("多行 viem 报错压成一行并保留 Details", () => {
    const raw = [
      "RPC Request failed.",
      "",
      "URL: https://rpc.testnet.arc.network",
      "Request body: {...}",
      "Details: request limit reached",
      "Version: viem@2.55.8",
    ].join("\n");
    expect(condenseErrorMessage(raw)).toBe("RPC Request failed.（Details: request limit reached）");
  });

  it("单行消息原样返回", () => {
    expect(condenseErrorMessage("连不上")).toBe("连不上");
  });

  it("超长消息截断并加省略号", () => {
    expect(condenseErrorMessage("x".repeat(300), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("deriveAddress", () => {
  it("从私钥派生地址", () => {
    expect(deriveAddress({ K: FAKE_KEY }, "K")).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("私钥缺失时抛错点名变量", () => {
    expect(() => deriveAddress({}, "PROCUREMENT_PRIVATE_KEY")).toThrow(
      /PROCUREMENT_PRIVATE_KEY 缺失/,
    );
  });
});

describe("describeBalances", () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
  const client = {
    getBalance: async () => 1_500_000_000_000_000_000n,
    readContract: async () => 2_500_000n,
  } as unknown as PublicClient<Transport, Chain>;

  it("同时报原生与钱包 USDC 余额（与 Gateway 可用余额是两个量）", async () => {
    await expect(
      describeBalances(client, ADDRESS, "0x3600000000000000000000000000000000000000"),
    ).resolves.toBe(`${ADDRESS} 原生 1.5，钱包 USDC 2.500000`);
  });

  it("未配置 USDC_ADDRESS 时如实说明没查", async () => {
    await expect(describeBalances(client, ADDRESS)).resolves.toContain("钱包 USDC 未查");
  });
});

describe("formatUsdc", () => {
  it("按 6 位小数格式化", () => {
    expect(formatUsdc(1_050_000n)).toBe("1.050000");
    expect(formatUsdc(0n)).toBe("0.000000");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(123_456_789n)).toBe("123.456789");
  });

  it("负数保留符号", () => {
    expect(formatUsdc(-1_500_000n)).toBe("-1.500000");
  });
});
