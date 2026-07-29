import { generatePrivateKey } from "viem/accounts";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { resolveSliceConfig } from "./config.js";
import type { SliceAddresses, SliceConfig } from "./config.js";
import { buildJobClient, selectChainMode } from "./job-client.js";

const ADDRESSES: SliceAddresses = {
  marketplace: `0x${"1".repeat(40)}` as Address,
  operator: `0x${"2".repeat(40)}` as Address,
  verifier: `0x${"3".repeat(40)}` as Address,
  procurement: `0x${"4".repeat(40)}` as Address,
};

const FEES = { platformFeeBP: 0n, evaluatorFeeBP: 0n } as const;

/** dry-run 替身产出的假 txHash 前缀。真交易哈希不可能长这样。 */
const DRY_RUN_TX_PREFIX = "0xdededede";

function envWithAddresses(): Record<string, string> {
  return {
    MARKETPLACE_PRIVATE_KEY: generatePrivateKey(),
    OPERATOR_PRIVATE_KEY: generatePrivateKey(),
    VERIFIER_PRIVATE_KEY: generatePrivateKey(),
    PROCUREMENT_PRIVATE_KEY: generatePrivateKey(),
    JOB_CONTRACT_ADDRESS: `0x${"a".repeat(40)}`,
    USDC_ADDRESS: `0x${"b".repeat(40)}`,
    ARC_RPC_URL: "https://example.invalid",
  };
}

describe("selectChainMode", () => {
  it("只看 dryRun 一个字段", () => {
    expect(selectChainMode({ dryRun: true })).toBe("dry-run-double");
    expect(selectChainMode({ dryRun: false })).toBe("real-client");
  });

  // 回归护栏：dry-run 现在会携带合约地址（为了真读费率 view），
  // 「有地址」绝不能让它滑到真 client 那条分支。
  it("dry-run 即使配了完整合约地址，仍然选替身", () => {
    const config = resolveSliceConfig(["--dry-run"], envWithAddresses());
    expect(config.jobContract).not.toBeNull();
    expect(config.usdc).not.toBeNull();
    expect(selectChainMode(config)).toBe("dry-run-double");
  });
});

describe("buildJobClient（纪律：--dry-run 绝不发链上交易）", () => {
  /** 单测零网络：dry-run 分支不碰 RPC，全程内存。 */
  async function runDryRunFlow(config: SliceConfig): Promise<string[]> {
    const client = buildJobClient(config, ADDRESSES, FEES);
    const { jobId } = await client.createJob({
      caseId: "case-1",
      provider: ADDRESSES.operator,
      evaluator: ADDRESSES.verifier,
      expiredAt: 1_800_000_000n,
      description: "citely-case:case-1",
    });
    const hashes: string[] = [];
    hashes.push(await client.setBudget(jobId, 3_000_000n));
    hashes.push(await client.fund(jobId, 3_000_000n));
    hashes.push(await client.submit(jobId, `0x${"c".repeat(64)}`));
    hashes.push(await client.complete(jobId, `0x${"d".repeat(64)}`));
    return hashes;
  }

  it("配了合约地址的 dry-run，走完全流程仍只产出替身的假 txHash", async () => {
    const config = resolveSliceConfig(["--dry-run"], envWithAddresses());
    const hashes = await runDryRunFlow(config);

    expect(hashes).toHaveLength(4);
    for (const hash of hashes) {
      // 真交易哈希是 keccak 输出，不可能是这个哨兵前缀。
      expect(hash.startsWith(DRY_RUN_TX_PREFIX)).toBe(true);
    }
  });

  it("没配合约地址的 dry-run 同样能跑完（不因缺地址而失败）", async () => {
    const hashes = await runDryRunFlow(resolveSliceConfig(["--dry-run"], {}));
    expect(hashes.every((h) => h.startsWith(DRY_RUN_TX_PREFIX))).toBe(true);
  });

  it("dry-run 的费率来自传入值，不是替身自带的常量", async () => {
    const config = resolveSliceConfig(["--dry-run"], envWithAddresses());
    const client = buildJobClient(config, ADDRESSES, { platformFeeBP: 250n, evaluatorFeeBP: 75n });
    expect(await client.getFeeRates()).toEqual({ platformFeeBP: 250n, evaluatorFeeBP: 75n });
  });

  it("真实模式缺合约地址 → 抛错中止，不静默退回替身", () => {
    const env = envWithAddresses();
    delete env["JOB_CONTRACT_ADDRESS"];
    // 真实模式在 resolveSliceConfig 阶段就该拦下。
    expect(() => resolveSliceConfig([], env)).toThrow(/JOB_CONTRACT_ADDRESS is not set/);
  });
});
