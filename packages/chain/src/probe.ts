import { getAddress, isAddress, type Address, type Chain, type PublicClient, type Transport } from "viem";

import { agenticCommerceAbi } from "./abi/agentic-commerce.js";
import { ChainError, wrapChainError } from "./errors.js";
import { ARC_TESTNET } from "./wallet.js";

/** spike ① 的探测结论。 */
export type ProbeVerdict = "DEPLOYED_AND_ABI_MATCHES" | "NO_CODE" | "ABI_MISMATCH" | "NOT_INITIALIZED";

/** `probeJobContract` 的产出，直接进 spike 报告。 */
export interface JobContractProbe {
  readonly address: Address;
  readonly chainId: number;
  /** 部署字节码长度（字节）。0 表示地址上没有合约。 */
  readonly codeSize: number;
  readonly paymentToken: Address;
  readonly jobCounter: bigint;
  readonly platformFeeBP: bigint;
  readonly evaluatorFeeBP: bigint;
  readonly platformTreasury: Address;
  readonly verdict: ProbeVerdict;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * 从命令行参数或环境变量取 8183 合约地址。
 *
 * @param argv - `process.argv.slice(2)`，支持 `--address 0x...`
 * @param envValue - `JOB_CONTRACT_ADDRESS` 的值
 */
export function resolveContractAddress(
  argv: readonly string[],
  envValue: string | undefined,
): Address {
  const flagIndex = argv.indexOf("--address");
  const fromFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const raw = (fromFlag ?? envValue)?.trim();
  if (raw === undefined || raw === "") {
    throw new ChainError(
      "缺少 8183 合约地址：在 .env 里填 JOB_CONTRACT_ADDRESS，或用 --address 0x... 传入候选地址" +
        "（该值由 spike ① 的结论回填）",
    );
  }
  if (!isAddress(raw, { strict: false })) {
    throw new ChainError(`8183 合约地址不是合法 EVM 地址：${raw}`);
  }
  return getAddress(raw);
}

async function assertArcTestnet(client: PublicClient<Transport, Chain>): Promise<number> {
  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET.id) {
    throw new ChainError(
      `RPC 指向的不是 Arc Testnet：chainId ${String(chainId)} ≠ ${String(ARC_TESTNET.id)}`,
    );
  }
  return chainId;
}

async function readCodeSize(
  client: PublicClient<Transport, Chain>,
  address: Address,
): Promise<number> {
  const code = await client.getCode({ address });
  return code === undefined || code === "0x" ? 0 : (code.length - 2) / 2;
}

/**
 * 只读探测 8183 参考合约：链、字节码、ABI 匹配性、费率。
 *
 * `paymentToken()` / `jobCounter()` 能正常 decode 才说明**部署字节码的选择子
 * 与我方 ABI 对得上**——这是"零自定义合约"下唯一能拿到的反证。
 *
 * @param client - 只读 client
 * @param address - 候选合约地址
 * @returns 探测结果；结论在 `verdict` 上，调用方据此决定是否需要部署
 */
export async function probeJobContract(
  client: PublicClient<Transport, Chain>,
  address: Address,
): Promise<JobContractProbe> {
  const chainId = await assertArcTestnet(client);
  const codeSize = await readCodeSize(client, address);
  const base = { address, chainId, codeSize } as const;
  if (codeSize === 0) {
    return {
      ...base,
      paymentToken: ZERO,
      jobCounter: 0n,
      platformFeeBP: 0n,
      evaluatorFeeBP: 0n,
      platformTreasury: ZERO,
      verdict: "NO_CODE",
    };
  }
  const reads = await readViews(client, address);
  return {
    ...base,
    ...reads,
    verdict: reads.paymentToken === ZERO ? "NOT_INITIALIZED" : "DEPLOYED_AND_ABI_MATCHES",
  };
}

async function readViews(
  client: PublicClient<Transport, Chain>,
  address: Address,
): Promise<{
  readonly paymentToken: Address;
  readonly jobCounter: bigint;
  readonly platformFeeBP: bigint;
  readonly evaluatorFeeBP: bigint;
  readonly platformTreasury: Address;
}> {
  const contract = { address, abi: agenticCommerceAbi } as const;
  try {
    const [paymentToken, jobCounter, platformFeeBP, evaluatorFeeBP, platformTreasury] =
      await Promise.all([
        client.readContract({ ...contract, functionName: "paymentToken" }),
        client.readContract({ ...contract, functionName: "jobCounter" }),
        client.readContract({ ...contract, functionName: "platformFeeBP" }),
        client.readContract({ ...contract, functionName: "evaluatorFeeBP" }),
        client.readContract({ ...contract, functionName: "platformTreasury" }),
      ]);
    return { paymentToken, jobCounter, platformFeeBP, evaluatorFeeBP, platformTreasury };
  } catch (error: unknown) {
    // 有字节码但 view 读不出来 = 选择子对不上，结论 ABI_MISMATCH。
    throw wrapChainError(
      error,
      `地址 ${address} 上有字节码但 view 读取失败（结论 = ABI_MISMATCH，` +
        "部署的不是我方校对过的 8183 参考实现)",
    );
  }
}
