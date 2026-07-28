import type { Chain, PublicClient, Transport } from "viem";
import { describe, expect, it } from "vitest";

import { ChainError } from "./errors.js";
import { probeJobContract, resolveContractAddress } from "./probe.js";

const ADDRESS = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const CHECKSUMMED = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const USDC = "0x3600000000000000000000000000000000000000";
const ZERO = "0x0000000000000000000000000000000000000000";

interface StubOptions {
  readonly chainId?: number;
  readonly code?: `0x${string}` | undefined;
  readonly paymentToken?: string;
  readonly readThrows?: boolean;
}

function makeClient(options: StubOptions = {}): PublicClient<Transport, Chain> {
  const stub = {
    getChainId: async () => options.chainId ?? 5042002,
    getCode: async () => options.code,
    readContract: async (req: { functionName: string }): Promise<unknown> => {
      if (options.readThrows === true) {
        throw new Error("execution reverted");
      }
      switch (req.functionName) {
        case "paymentToken":
          return options.paymentToken ?? USDC;
        case "jobCounter":
          return 7n;
        case "platformFeeBP":
          return 250n;
        case "evaluatorFeeBP":
          return 100n;
        case "platformTreasury":
          return "0x9999999999999999999999999999999999999999";
        default:
          throw new Error(`未预期的读调用：${req.functionName}`);
      }
    },
  };
  return stub as unknown as PublicClient<Transport, Chain>;
}

describe("resolveContractAddress", () => {
  it("--address 优先于环境变量", () => {
    expect(resolveContractAddress(["--address", ADDRESS], USDC)).toBe(CHECKSUMMED);
  });

  it("没有 --address 时用环境变量", () => {
    expect(resolveContractAddress([], ADDRESS)).toBe(CHECKSUMMED);
  });

  it("两者都没有时给出可操作的提示", () => {
    expect(() => resolveContractAddress([], undefined)).toThrow(ChainError);
    expect(() => resolveContractAddress([], "  ")).toThrow(/JOB_CONTRACT_ADDRESS/);
  });

  it("非法地址报错", () => {
    expect(() => resolveContractAddress(["--address", "0x1234"], undefined)).toThrow(
      /不是合法 EVM 地址/,
    );
  });
});

describe("probeJobContract", () => {
  it("链不对时立即中止", async () => {
    await expect(probeJobContract(makeClient({ chainId: 1 }), CHECKSUMMED)).rejects.toThrow(
      /不是 Arc Testnet/,
    );
  });

  it("地址无字节码时结论为 NO_CODE，且不去读 view", async () => {
    const probe = await probeJobContract(makeClient({ code: "0x", readThrows: true }), CHECKSUMMED);
    expect(probe.verdict).toBe("NO_CODE");
    expect(probe.codeSize).toBe(0);
  });

  it("getCode 返回 undefined 同样判为 NO_CODE", async () => {
    const probe = await probeJobContract(makeClient({ code: undefined }), CHECKSUMMED);
    expect(probe.verdict).toBe("NO_CODE");
  });

  it("有字节码且 view 可读时结论为 DEPLOYED_AND_ABI_MATCHES", async () => {
    const probe = await probeJobContract(makeClient({ code: "0x60806040" }), CHECKSUMMED);
    expect(probe).toMatchObject({
      verdict: "DEPLOYED_AND_ABI_MATCHES",
      codeSize: 4,
      paymentToken: USDC,
      jobCounter: 7n,
      platformFeeBP: 250n,
      evaluatorFeeBP: 100n,
    });
  });

  it("paymentToken 为零地址时结论为 NOT_INITIALIZED", async () => {
    const probe = await probeJobContract(
      makeClient({ code: "0x60806040", paymentToken: ZERO }),
      CHECKSUMMED,
    );
    expect(probe.verdict).toBe("NOT_INITIALIZED");
  });

  it("有字节码但 view 读不出来时报 ABI_MISMATCH", async () => {
    await expect(
      probeJobContract(makeClient({ code: "0x60806040", readThrows: true }), CHECKSUMMED),
    ).rejects.toThrow(/ABI_MISMATCH/);
  });
});
