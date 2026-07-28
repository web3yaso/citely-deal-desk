import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  assertDistinctKeys,
  deriveAddresses,
  resolveSliceConfig,
  SliceConfigError,
} from "./config.js";

const ADDRESS = `0x${"a".repeat(40)}`;

function fullEnv(): Record<string, string> {
  return {
    MARKETPLACE_PRIVATE_KEY: generatePrivateKey(),
    OPERATOR_PRIVATE_KEY: generatePrivateKey(),
    VERIFIER_PRIVATE_KEY: generatePrivateKey(),
    PROCUREMENT_PRIVATE_KEY: generatePrivateKey(),
    JOB_CONTRACT_ADDRESS: ADDRESS,
    USDC_ADDRESS: `0x${"b".repeat(40)}`,
  };
}

describe("resolveSliceConfig", () => {
  it("--dry-run 且无 .env → 用一次性演示密钥，不要求合约地址", () => {
    const config = resolveSliceConfig(["--dry-run"], {});
    expect(config.dryRun).toBe(true);
    expect(config.ephemeralKeys).toBe(true);
    expect(config.jobContract).toBeNull();
    // 一次性密钥必须真的互不相同，否则 8183 会因角色重合而 Unauthorized。
    expect(() => assertDistinctKeys(config.keys)).not.toThrow();
  });

  it("两次生成的一次性密钥互不相同（不是写死的）", () => {
    const a = resolveSliceConfig(["--dry-run"], {});
    const b = resolveSliceConfig(["--dry-run"], {});
    expect(a.keys.operator).not.toBe(b.keys.operator);
  });

  it("--dry-run 且有 .env → 用 .env 的密钥，仍不发交易", () => {
    const env = fullEnv();
    const config = resolveSliceConfig(["--dry-run"], env);
    expect(config.ephemeralKeys).toBe(false);
    expect(config.keys.operator).toBe(env["OPERATOR_PRIVATE_KEY"]);
    expect(config.jobContract).toBeNull();
  });

  // 演示现场最危险的失败方式就是"缺配置就自动降级"。
  it("真实模式缺密钥 → 抛错中止，绝不自动退回 dry-run", () => {
    expect(() => resolveSliceConfig([], {})).toThrow(SliceConfigError);
    expect(() => resolveSliceConfig([], {})).toThrow(/MARKETPLACE_PRIVATE_KEY is not set/);
  });

  it("真实模式缺合约地址 → 抛错中止", () => {
    const env = fullEnv();
    delete env["JOB_CONTRACT_ADDRESS"];
    expect(() => resolveSliceConfig([], env)).toThrow(/JOB_CONTRACT_ADDRESS is not set/);
  });

  it("私钥形状非法 → 抛错，且错误消息不回显变量值", () => {
    const env = { ...fullEnv(), OPERATOR_PRIVATE_KEY: "sekrit-but-wrong-shape" };
    try {
      resolveSliceConfig([], env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SliceConfigError);
      expect((err as Error).message).not.toContain("sekrit-but-wrong-shape");
    }
  });

  it("真实模式读到完整配置", () => {
    const config = resolveSliceConfig([], fullEnv());
    expect(config.dryRun).toBe(false);
    expect(config.jobContract).toBe(ADDRESS);
    expect(config.adjudicatorMode).toBe("cache_only");
  });

  it("ADJUDICATOR_MODE 可显式覆盖（cache_only 用于离线复现）", () => {
    const config = resolveSliceConfig(["--dry-run"], {
      ...fullEnv(),
      ADJUDICATOR_MODE: "cache_only",
    });
    expect(config.adjudicatorMode).toBe("cache_only");
  });
});

describe("assertDistinctKeys（v2.2 §2.3 四把密钥物理分离）", () => {
  it("任意两个角色共用同一把钥匙 → 抛错", () => {
    const shared = generatePrivateKey();
    expect(() =>
      assertDistinctKeys({
        marketplace: shared,
        operator: shared,
        verifier: generatePrivateKey(),
        procurement: generatePrivateKey(),
      }),
    ).toThrow(SliceConfigError);
  });

  it("四把不同的钥匙通过", () => {
    expect(() =>
      assertDistinctKeys({
        marketplace: generatePrivateKey(),
        operator: generatePrivateKey(),
        verifier: generatePrivateKey(),
        procurement: generatePrivateKey(),
      }),
    ).not.toThrow();
  });

  // 客户侧 agent 拿到运营密钥 = 核验方与出具方成了同一个人，叙事整个塌掉。
  it("client 与 provider 共用密钥被明确挡住", () => {
    const shared = generatePrivateKey();
    expect(() =>
      assertDistinctKeys({
        marketplace: shared,
        operator: shared,
        verifier: generatePrivateKey(),
        procurement: generatePrivateKey(),
      }),
    ).toThrow(/物理分离/);
  });
});

describe("deriveAddresses", () => {
  it("四个角色地址与私钥一一对应", () => {
    const keys = {
      marketplace: generatePrivateKey(),
      operator: generatePrivateKey(),
      verifier: generatePrivateKey(),
      procurement: generatePrivateKey(),
    };
    const addresses = deriveAddresses(keys);
    expect(addresses.operator).toBe(privateKeyToAccount(keys.operator).address);
    expect(new Set(Object.values(addresses)).size).toBe(4);
  });
});
