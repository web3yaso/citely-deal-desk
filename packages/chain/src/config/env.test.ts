import { afterEach, describe, expect, it } from "vitest";

import { ChainError } from "../errors.js";
import {
  ARC_TESTNET_CHAIN_ID,
  DEFAULT_CHAIN_POLL_INTERVAL_MS,
  ENV_KEYS,
  isDatedModelSnapshot,
  loadChainEnv,
  loadDotEnvFile,
  optionalEnv,
  readAddress,
  readPositiveInt,
  readPrivateKey,
  readUrl,
  requireEnv,
  type EnvSource,
} from "./env.js";
import { clearRegisteredSecrets, redactSecrets } from "./redact.js";

// 全 a/b/c/d/e 的假私钥，不对应任何真实账户，测试零网络零真实密钥。
const KEY = (c: string): string => `0x${c.repeat(64)}`;

const FULL_ENV: EnvSource = {
  [ENV_KEYS.chainId]: "5042002",
  [ENV_KEYS.rpcUrl]: "https://rpc.testnet.arc.network",
  [ENV_KEYS.rpcUrlFallback]: "https://arc-testnet.drpc.org",
  [ENV_KEYS.operatorKey]: KEY("a"),
  [ENV_KEYS.verifierKey]: KEY("b"),
  [ENV_KEYS.marketplaceKey]: KEY("c"),
  [ENV_KEYS.procurementKey]: KEY("d"),
  [ENV_KEYS.moduleAttesterKey]: KEY("e"),
  [ENV_KEYS.jobContract]: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  [ENV_KEYS.usdc]: "0x3600000000000000000000000000000000000000",
  [ENV_KEYS.gatewayWallet]: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
  [ENV_KEYS.msbAgentBaseUrl]: "https://msb-agent-production-769d.up.railway.app",
  [ENV_KEYS.facilitatorUrl]: "https://gateway-api-testnet.circle.com/v1/x402",
};

/** 去掉一个变量。用 rest 解构会踩到 no-unused-vars，这里显式删更直白。 */
function without(env: EnvSource, key: string): EnvSource {
  const copy: Record<string, string | undefined> = { ...env };
  delete copy[key];
  return copy;
}

afterEach(() => {
  clearRegisteredSecrets();
});

describe("requireEnv / optionalEnv", () => {
  it("读到值并去掉首尾空白", () => {
    expect(requireEnv({ FOO: "  bar  " }, "FOO", "提示")).toBe("bar");
    expect(optionalEnv({ FOO: "  bar  " }, "FOO")).toBe("bar");
  });

  it("缺失时报错点名变量并指向 .env.example", () => {
    expect(() => requireEnv({}, "FOO", "该填什么")).toThrow(ChainError);
    expect(() => requireEnv({ FOO: "  " }, "FOO", "该填什么")).toThrow(
      /FOO 缺失或为空：该填什么（模板见仓库根 \.env\.example）/,
    );
  });

  it("空串按未设置处理", () => {
    expect(optionalEnv({ FOO: "" }, "FOO")).toBeUndefined();
    expect(optionalEnv({}, "FOO")).toBeUndefined();
  });
});

describe("readPrivateKey", () => {
  it("接受合法私钥并登记进脱敏表", () => {
    const key = readPrivateKey({ K: KEY("a") }, "K");
    expect(key).toBe(KEY("a"));
    expect(redactSecrets(`rpc error: ${KEY("a")}`)).toBe("rpc error: [REDACTED]");
  });

  it("不带 0x 前缀的值也登记为脱敏项", () => {
    readPrivateKey({ K: "a".repeat(64) }, "K");
    expect(redactSecrets(`raw ${"a".repeat(64)}`)).toBe("raw [REDACTED]");
  });

  it("形状不合法时报错且不回显值", () => {
    try {
      readPrivateKey({ K: `0x${"a".repeat(63)}` }, "K");
      expect.unreachable("应当抛错");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ChainError);
      expect((error as ChainError).message).toContain("K 格式非法");
      expect((error as ChainError).message).not.toContain("aaaa");
    }
  });

  it("缺失时报错点名变量", () => {
    expect(() => readPrivateKey({}, "OPERATOR_PRIVATE_KEY")).toThrow(
      /OPERATOR_PRIVATE_KEY 缺失/,
    );
  });
});

describe("readAddress", () => {
  it("转成 EIP-55 校验和形式", () => {
    expect(readAddress({ A: "0x0077777d7eba4688bdef3e311b846f25870a19b9" }, "A", "x")).toBe(
      "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    );
  });

  it("非法地址报错", () => {
    expect(() => readAddress({ A: "0xdeadbeef" }, "A", "x")).toThrow(/不是合法的 EVM 地址/);
  });

  it("缺失时报错", () => {
    expect(() => readAddress({}, "JOB_CONTRACT_ADDRESS", "spike ① 回填")).toThrow(
      /JOB_CONTRACT_ADDRESS 缺失或为空：spike ① 回填/,
    );
  });
});

describe("readPositiveInt", () => {
  it("未设置时用缺省值", () => {
    expect(readPositiveInt({}, "N", 5000)).toBe(5000);
  });

  it("解析正整数", () => {
    expect(readPositiveInt({ N: "1500" }, "N", 5000)).toBe(1500);
  });

  it("拒绝 0、负数与小数", () => {
    expect(() => readPositiveInt({ N: "0" }, "N", 1)).toThrow(/必须是正整数/);
    expect(() => readPositiveInt({ N: "-3" }, "N", 1)).toThrow(/必须是正整数/);
    expect(() => readPositiveInt({ N: "1.5" }, "N", 1)).toThrow(/必须是正整数/);
  });
});

describe("readUrl", () => {
  it("接受 HTTPS 并去掉尾部斜杠", () => {
    expect(readUrl({ U: "https://example.com/" }, "U", "x")).toBe("https://example.com");
  });

  it("拒绝明文 HTTP 的公网地址", () => {
    expect(() => readUrl({ U: "http://example.com" }, "U", "x")).toThrow(/必须使用 HTTPS/);
  });

  it("允许本地 http", () => {
    expect(readUrl({ U: "http://localhost:8545" }, "U", "x")).toBe("http://localhost:8545");
  });

  it("非法 URL 报错", () => {
    expect(() => readUrl({ U: "not a url" }, "U", "x")).toThrow(/不是合法 URL/);
  });
});

describe("isDatedModelSnapshot", () => {
  it("带日期的 snapshot ID 通过", () => {
    expect(isDatedModelSnapshot("gpt-5.6-luna-2026-05-13")).toBe(true);
  });

  it("别名不通过", () => {
    expect(isDatedModelSnapshot("gpt-5.6-luna")).toBe(false);
    expect(isDatedModelSnapshot("gpt-4o-latest")).toBe(false);
  });
});

describe("loadChainEnv", () => {
  it("全量读取成功", () => {
    const env = loadChainEnv(FULL_ENV);
    expect(env.chainId).toBe(ARC_TESTNET_CHAIN_ID);
    expect(env.rpc.fallbackUrl).toBe("https://arc-testnet.drpc.org");
    expect(env.keys.operator).toBe(KEY("a"));
    expect(env.keys.procurement).toBe(KEY("d"));
    expect(env.addresses.gatewayWallet).toBe("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
    expect(env.pollIntervalMs).toBe(DEFAULT_CHAIN_POLL_INTERVAL_MS);
  });

  it("缺备用 RPC 时不写入 fallbackUrl 字段", () => {
    const env = loadChainEnv(without(FULL_ENV, ENV_KEYS.rpcUrlFallback));
    expect("fallbackUrl" in env.rpc).toBe(false);
  });

  it("chainId 不是 Arc Testnet 时中止", () => {
    expect(() => loadChainEnv({ ...FULL_ENV, [ENV_KEYS.chainId]: "1" })).toThrow(
      /与 Arc Testnet \(5042002\) 不一致/,
    );
  });

  it("缺 JOB_CONTRACT_ADDRESS 时错误消息能指出是哪一项", () => {
    expect(() => loadChainEnv(without(FULL_ENV, ENV_KEYS.jobContract))).toThrow(/JOB_CONTRACT_ADDRESS 缺失或为空/);
  });

  it("任何一项报错都不会泄漏已登记的私钥", () => {
    try {
      loadChainEnv(without(FULL_ENV, ENV_KEYS.usdc));
      expect.unreachable("应当抛错");
    } catch (error: unknown) {
      expect((error as ChainError).message).not.toContain("aaaa");
    }
  });
});

describe("loadDotEnvFile", () => {
  it("文件不存在时返回 false 且不抛错", () => {
    expect(loadDotEnvFile("/tmp/definitely-not-here-citely.env")).toBe(false);
  });
});
