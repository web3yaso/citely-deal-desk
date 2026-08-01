import { erc20Abi, formatEther, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  isDatedModelSnapshot,
  optionalEnv,
  readPrivateKey,
  type EnvSource,
} from "./config/env.js";
import { safeErrorMessage } from "./config/redact.js";

/**
 * 体检项的三态。
 *
 * `pending` 是「还没到该有值的时候」（例如 spike ① 未出结论前的
 * `JOB_CONTRACT_ADDRESS`），它不算失败——把「等上游」和「配错了」混成一个 ❌，
 * 用户只会去修一个根本没坏的东西。
 */
export type HealthStatus = "ok" | "fail" | "pending";

/** 体检单的一行。`detail` 会被打印，**绝不允许**装任何密钥值。 */
export interface HealthCheckLine {
  readonly name: string;
  readonly status: HealthStatus;
  readonly detail: string;
}

const ICONS: Record<HealthStatus, string> = { ok: "✅", fail: "❌", pending: "⏳" };

/** 把一行体检结果渲染成 `✅ 名称 — 说明`。 */
export function formatCheckLine(line: HealthCheckLine): string {
  return `${ICONS[line.status]} ${line.name} — ${line.detail}`;
}

/** 汇总体检结果。`ok` 为真表示没有 ❌（⏳ 不算失败）。 */
export function summarize(lines: readonly HealthCheckLine[]): {
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  readonly ok: boolean;
} {
  const count = (status: HealthStatus): number =>
    lines.filter((line) => line.status === status).length;
  const failed = count("fail");
  return { passed: count("ok"), failed, pending: count("pending"), ok: failed === 0 };
}

/**
 * 跑一项体检：抛错不中断整张单子，转成 ❌ 一行。
 *
 * 体检的价值在于「一次看全所有问题」，第一项失败就退出等于每修一个问题重跑一轮。
 *
 * @param name - 项目名
 * @param probe - 探测逻辑，返回给用户看的说明
 */
export async function runCheck(
  name: string,
  probe: () => Promise<string> | string,
): Promise<HealthCheckLine> {
  try {
    return { name, status: "ok", detail: await probe() };
  } catch (error: unknown) {
    return { name, status: "fail", detail: condenseErrorMessage(safeErrorMessage(error)) };
  }
}

/**
 * 把多行的底层报错压成一行。
 *
 * viem 的合约报错会连请求体、ABI、文档链接一起吐出来（几十行），体检单被冲得没法读；
 * 这里只留第一行加 `Details:` 那句——真要看全文去看抛出的 `cause`。
 *
 * @param raw - 已脱敏的错误消息
 * @param maxLength - 截断长度
 */
export function condenseErrorMessage(raw: string, maxLength = 400): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0] ?? "";
  const details = lines.find((line) => line.startsWith("Details:"));
  const merged = details === undefined || details === first ? first : `${first}（${details}）`;
  return merged.length <= maxLength ? merged : `${merged.slice(0, maxLength)}…`;
}

/** 标一项为「等上游产出」，不算失败。 */
export function pendingCheck(name: string, detail: string): HealthCheckLine {
  return { name, status: "pending", detail };
}

/**
 * 校验一把私钥的格式，并回报其**地址**（公开信息）——绝不回显私钥。
 *
 * @param env - 环境变量来源
 * @param varName - 变量名，例如 `OPERATOR_PRIVATE_KEY`
 */
export function checkPrivateKeyFormat(env: EnvSource, varName: string): HealthCheckLine {
  try {
    const account = privateKeyToAccount(readPrivateKey(env, varName));
    return { name: varName, status: "ok", detail: `格式合法，地址 ${account.address}` };
  } catch (error: unknown) {
    return { name: varName, status: "fail", detail: condenseErrorMessage(safeErrorMessage(error)) };
  }
}

/**
 * 专家钱包为什么可以没有 gas：Review Job 由 Marketplace 发起 `createJob`，
 * 专家只是 `provider` 参数里的收款方，全程不需要自己发交易。
 */
export const REVIEW_EXPERT_GAS_NOTE =
  "通常不需要 gas（Review Job 由 Marketplace 发起 createJob，专家只是 provider 参数里的收款方）" +
  "，除非要演示专家主动 submit 评审结果";

/**
 * 出口 4 专家钱包体检：格式、地址、原生币余额三件事一行说清。
 *
 * 两处刻意不报红：**没配**（只有出口 4 需要它）与**余额为 0**（不需要 gas），
 * 都标 ⏳。把「等用得上时再配」和「配错了」混成同一个 ❌，用户只会去修没坏的东西。
 *
 * @param env - 环境变量来源
 * @param varName - 私钥变量名，即 `REVIEW_EXPERT_PRIVATE_KEY`
 * @param getNativeBalance - 查原生币余额；注入以便测试零网络
 */
export async function checkReviewExpertWallet(
  env: EnvSource,
  varName: string,
  getNativeBalance: (address: Address) => Promise<bigint>,
): Promise<HealthCheckLine> {
  const name = `出口 4 专家钱包（${varName}）`;
  if (optionalEnv(env, varName) === undefined) {
    return pendingCheck(name, "未设置：只有出口 4（解释性 gray）的 Review Job 需要它，见 .env.example");
  }
  let empty = false;
  const line = await runCheck(name, async () => {
    const address = privateKeyToAccount(readPrivateKey(env, varName)).address;
    const native = await getNativeBalance(address);
    empty = native === 0n;
    return empty
      ? `${address} 原生 0，${REVIEW_EXPERT_GAS_NOTE}`
      : `${address} 原生 ${formatEther(native)}`;
  });
  // 余额为 0 是常态而非故障，降级成 ⏳；格式错/查询失败仍是 runCheck 给的 ❌。
  return line.status === "ok" && empty ? pendingCheck(line.name, line.detail) : line;
}

/** 只报「是否设置」，不报值也不报前缀——API key 前缀也算敏感信息。 */
export function checkOpenAiApiKey(env: EnvSource): HealthCheckLine {
  const present = (env["OPENAI_API_KEY"]?.trim() ?? "") !== "";
  return {
    name: "OPENAI_API_KEY",
    status: present ? "ok" : "fail",
    detail: present ? "已设置（值不打印）" : "未设置：判定器无法工作",
  };
}

/** `OPENAI_MODEL` 必须是带日期的 snapshot ID，别名漂移会让 golden cache 静默失效。 */
export function checkOpenAiModel(env: EnvSource): HealthCheckLine {
  const model = env["OPENAI_MODEL"]?.trim() ?? "";
  if (model === "") {
    return pendingCheck("OPENAI_MODEL", "未设置：等 engine 的 spike ⑨ 取回带日期的 snapshot ID");
  }
  const dated = isDatedModelSnapshot(model);
  return {
    name: "OPENAI_MODEL",
    status: dated ? "ok" : "fail",
    detail: dated ? `${model}（带日期 snapshot）` : `${model} 是别名：别名漂移=golden cache 静默失效`,
  };
}

/**
 * 由环境变量里的私钥派生地址。地址是公开信息，私钥不出这个函数。
 *
 * @param env - 环境变量来源
 * @param varName - 私钥变量名
 */
export function deriveAddress(env: EnvSource, varName: string): Address {
  return privateKeyToAccount(readPrivateKey(env, varName)).address;
}

/**
 * 查一个地址的原生代币与**钱包** USDC 余额，渲染成体检单里的一行说明。
 *
 * ⚠️ 钱包 USDC 余额与 Gateway 可用余额是**两个不同的量**：x402 付款花的是
 * Gateway 余额，钱包里有 USDC ≠ 能付款。所以两者在体检单上分两行显示，
 * 这一行末尾也明写「钱包」二字。
 *
 * @param client - 只读 client
 * @param address - 被查地址
 * @param usdcAddress - USDC 合约地址；未配置时跳过 USDC 一栏并如实说明
 */
export async function describeBalances(
  client: PublicClient<Transport, Chain>,
  address: Address,
  usdcAddress?: Address,
): Promise<string> {
  const native = await client.getBalance({ address });
  if (usdcAddress === undefined) {
    return `${address} 原生 ${formatEther(native)}，钱包 USDC 未查（USDC_ADDRESS 未设置）`;
  }
  const usdc = await client.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return `${address} 原生 ${formatEther(native)}，钱包 USDC ${formatUsdc(usdc)}`;
}

/**
 * 原子单位 → 人类可读的 USDC 金额（6 位小数）。
 *
 * @param atomic - 6 位小数原子单位
 */
export function formatUsdc(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}
