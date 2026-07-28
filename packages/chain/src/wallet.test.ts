import { createPublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChainError } from "./errors.js";
import {
  ARC_TESTNET,
  assertPrivateKey,
  createArcPublicClient,
  createArcTransport,
  createChainClients,
} from "./wallet.js";

// 测试用假私钥（32 字节全 a / 全 b），不对应任何真实账户，也不联网。
const KEY_A = `0x${"a".repeat(64)}` as const;
const KEY_B = `0x${"b".repeat(64)}` as const;

const PRIMARY = "https://primary.invalid/rpc";
const FALLBACK = "https://fallback.invalid/rpc";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ARC_TESTNET", () => {
  it("chainId 是 5042002", () => {
    expect(ARC_TESTNET.id).toBe(5042002);
  });
});

describe("assertPrivateKey", () => {
  it("接受合法私钥", () => {
    expect(assertPrivateKey(KEY_A, "OPERATOR_KEY")).toBe(KEY_A);
  });

  it("自动补全缺失的 0x 前缀", () => {
    expect(assertPrivateKey("a".repeat(64), "OPERATOR_KEY")).toBe(KEY_A);
  });

  it("去掉首尾空白", () => {
    expect(assertPrivateKey(`  ${KEY_A}  `, "OPERATOR_KEY")).toBe(KEY_A);
  });

  it("缺失时抛出带变量名的 ChainError", () => {
    expect(() => assertPrivateKey(undefined, "OPERATOR_KEY")).toThrow(ChainError);
    expect(() => assertPrivateKey("", "OPERATOR_KEY")).toThrow(/OPERATOR_KEY 缺失/);
  });

  it("长度不对时报错", () => {
    expect(() => assertPrivateKey("0xdeadbeef", "OPERATOR_KEY")).toThrow(/格式非法/);
  });

  it("含非十六进制字符时报错", () => {
    expect(() => assertPrivateKey(`0x${"z".repeat(64)}`, "OPERATOR_KEY")).toThrow(/格式非法/);
  });

  it("报错消息里不回显传入的值", () => {
    const almostKey = `0x${"a".repeat(63)}`;
    try {
      assertPrivateKey(almostKey, "OPERATOR_KEY");
      expect.unreachable("应当抛错");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ChainError);
      expect((error as ChainError).message).not.toContain("aaaa");
    }
  });
});

describe("createChainClients", () => {
  it("三把密钥各自建立独立 client，互不共用", () => {
    const rpc = { primaryUrl: PRIMARY };
    const operator = createChainClients("operator", KEY_A, rpc);
    const verifier = createChainClients("verifier", KEY_B, rpc);

    expect(operator.address).not.toBe(verifier.address);
    expect(operator.publicClient).not.toBe(verifier.publicClient);
    expect(operator.walletClient).not.toBe(verifier.walletClient);
    expect(operator.walletClient.account.address).toBe(operator.address);
    expect(verifier.role).toBe("verifier");
  });

  it("client 绑定在 Arc Testnet 上", () => {
    const { publicClient, walletClient } = createChainClients("procurement", KEY_A, {
      primaryUrl: PRIMARY,
    });
    expect(publicClient.chain.id).toBe(5042002);
    expect(walletClient.chain.id).toBe(5042002);
  });

  it("私钥非法时抛 ChainError 且消息不含私钥", () => {
    // 绕过 assertPrivateKey 直接喂给 viem，模拟上游校验被跳过的情形。
    const bogus = `0x${"f".repeat(63)}g` as `0x${string}`;
    try {
      createChainClients("operator", bogus, { primaryUrl: PRIMARY });
      expect.unreachable("应当抛错");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ChainError);
      expect((error as ChainError).message).not.toContain("ffff");
    }
  });
});

describe("createArcPublicClient", () => {
  it("只读 client 绑定 Arc Testnet 且不含账户", () => {
    const client = createArcPublicClient({ primaryUrl: PRIMARY, fallbackUrl: FALLBACK });
    expect(client.chain.id).toBe(5042002);
    expect(client.account).toBeUndefined();
  });

  it("主 RPC 失败时降级到备用 RPC", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      if (url === PRIMARY) {
        throw new TypeError("fetch failed");
      }
      const id = JSON.parse(init?.body ?? "{}") as { id?: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: id.id ?? 1, result: "0x4cef52" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createArcPublicClient({ primaryUrl: PRIMARY, fallbackUrl: FALLBACK });
    await expect(client.getChainId()).resolves.toBe(5042002);
    expect(seen).toContain(FALLBACK);
  }, 15_000);
});

describe("RPC 限流降级（不是连接失败，是请求被拒）", () => {
  /**
   * 公共 RPC `rpc.testnet.arc.network` 实测会限流：主导连读五个 view，后三个直接
   * `RPC Request failed / request limit reached`。降级必须覆盖这一类——
   * 「连不上」有 fetch 异常，「被拒」是对方好好地回了一个拒绝，两条路径不一样。
   */
  function stubRateLimitedPrimary(mode: "http429" | "jsonRpcError"): string[] {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      const id = (JSON.parse(init?.body ?? "{}") as { id?: number }).id ?? 1;
      if (url === PRIMARY) {
        return mode === "http429"
          ? new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "request limit reached" } }), {
              status: 429,
              headers: { "content-type": "application/json" },
            })
          : new Response(
              JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "request limit reached" } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x4cef52" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return seen;
  }

  it("主 RPC 返回 HTTP 429 时切到备用 RPC", async () => {
    const seen = stubRateLimitedPrimary("http429");
    const client = createArcPublicClient({ primaryUrl: PRIMARY, fallbackUrl: FALLBACK });
    await expect(client.getChainId()).resolves.toBe(5042002);
    expect(seen).toContain(FALLBACK);
  }, 20_000);

  it("主 RPC 用 200 + JSON-RPC error 拒绝时也切到备用 RPC", async () => {
    const seen = stubRateLimitedPrimary("jsonRpcError");
    const client = createArcPublicClient({ primaryUrl: PRIMARY, fallbackUrl: FALLBACK });
    await expect(client.getChainId()).resolves.toBe(5042002);
    expect(seen).toContain(FALLBACK);
  }, 20_000);
});

describe("createArcTransport（RPC 降级）", () => {
  it("主 RPC 失败时自动切到备用 RPC", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      if (url === PRIMARY) {
        throw new TypeError("fetch failed");
      }
      const id = JSON.parse(init?.body ?? "{}") as { id?: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: id.id ?? 1, result: "0x4cef52" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createPublicClient({
      chain: ARC_TESTNET,
      transport: createArcTransport({ primaryUrl: PRIMARY, fallbackUrl: FALLBACK }),
    });

    await expect(client.getChainId()).resolves.toBe(5042002);
    expect(seen[0]).toBe(PRIMARY);
    expect(seen).toContain(FALLBACK);
  }, 15_000);

  it("主 RPC 正常时不会打到备用 RPC", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }): Promise<Response> => {
      seen.push(String(input));
      const id = JSON.parse(init?.body ?? "{}") as { id?: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: id.id ?? 1, result: "0x4cef52" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createPublicClient({
      chain: ARC_TESTNET,
      transport: createArcTransport({ primaryUrl: PRIMARY, fallbackUrl: FALLBACK }),
    });

    await expect(client.getChainId()).resolves.toBe(5042002);
    expect(seen).toEqual([PRIMARY]);
  });

  it("未配置备用 RPC 时只用主 RPC", () => {
    const transport = createArcTransport({ primaryUrl: PRIMARY });
    const { value } = transport({ chain: ARC_TESTNET });
    expect(value?.transports).toHaveLength(1);
  });

  it("配置备用 RPC 时顺序为主、备", () => {
    const transport = createArcTransport({ primaryUrl: PRIMARY, fallbackUrl: FALLBACK });
    const { value } = transport({ chain: ARC_TESTNET });
    expect(value?.transports).toHaveLength(2);
  });
});
