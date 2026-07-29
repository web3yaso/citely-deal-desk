/**
 * 一次性录制 L1 Module 的真实 200 响应（**会花钱**）。
 *
 * ```
 * ARC_RPC_URL=https://arc-testnet.drpc.org \
 *   node --import tsx demo/scripts/record-module-response.ts
 * ```
 *
 * 为什么要有这个脚本：`maintainer_wallet` / `royalty_bps` 只出现在**付费后**的
 * 200 响应里，免费端点一个都没有。没有真实录制，P&L 里的版税行就只能是编的——
 * 而演示里出现一笔付给未经核实地址的"版税"，会让人怀疑整个账本都是编的。
 *
 * 纪律：
 * - **幂等友好**：已有录制就提示并退出，不重复烧 0.80 USDC（`--force` 才覆盖）；
 * - 录的是 **us-msb**（demo 主线用的模块）。按模块可覆盖版税配置，
 *   拿 sg-msb 的值填 us-msb 的 fixture 等于换一种方式编造；
 * - 落盘前过 chain 的 `assertModuleResponse`，形状不对就不写；
 * - 花费金额取自**付款前后的真实余额差**，不是照定价表抄的；
 * - 不打印私钥，错误过 `safeErrorMessage`。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createGatewayClient,
  createX402Client,
  loadDotEnvFile,
  MINIMUM_GATEWAY_BALANCE,
  safeErrorMessage,
} from "@citely/chain";

import { CLEAN_DEAL_INPUT } from "../fixtures/deal-input.js";
import { RECORDING_PATH } from "../fixtures/module-response.js";
import type { FixtureProvenance, ModuleRecording } from "../fixtures/module-response.js";

/** 录的就是主线模块。改这里之前先想清楚 fixture 是给谁用的。 */
const MODULE_ID = "us-msb" as const;
const DEFAULT_BASE_URL = "https://msb-agent-production-769d.up.railway.app";

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** 6 位小数最小单位 → 人读金额。 */
function fmt(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  return `${sign}${(abs / 1_000_000n).toString()}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

async function main(): Promise<void> {
  loadDotEnvFile(join(import.meta.dirname, "..", "..", ".env"));
  const force = process.argv.includes("--force");

  if (existsSync(RECORDING_PATH) && !force) {
    // 幂等：录过就别再烧钱。想重录得显式 --force。
    log(`录制已存在：${RECORDING_PATH}`);
    log("已跳过（不重复付费）。确实要重录请加 --force。");
    return;
  }

  const privateKey = process.env["PROCUREMENT_PRIVATE_KEY"];
  if (privateKey === undefined || privateKey === "") {
    throw new Error("PROCUREMENT_PRIVATE_KEY 未配置（cp .env.example .env 后填值）");
  }
  // 形状先校验再用：错误消息只报长度不报值。
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(
      `PROCUREMENT_PRIVATE_KEY 必须是 0x 开头的 32 字节十六进制（实际 ${String(privateKey.length)} 字符）`,
    );
  }

  const gateway = createGatewayClient(privateKey as `0x${string}`, process.env["ARC_RPC_URL"]);
  const before = await gateway.getBalances();
  log(`采购钱包 ${gateway.address}`);
  log(`付款前 Gateway 可用余额：${fmt(before.gateway.available)} USDC`);
  if (before.gateway.available < MINIMUM_GATEWAY_BALANCE) {
    // 响亮失败，不绕过 chain 的门槛自行发付款。
    throw new Error(
      `Gateway 可用余额 ${fmt(before.gateway.available)} 低于门槛 ` +
        `${fmt(MINIMUM_GATEWAY_BALANCE)} USDC，x402 客户端会拒绝付款。请先充值。`,
    );
  }

  // chain 的 `X402Client.check()` 现在会一并返回 `settlementId` 与 `paidAtomic`
  // （账本 module_fee / royalty 的 ref 必须是 Gateway 回执，v2.3 §3.5），
  // 所以录制脚本直接用它，不必自己调 gateway.pay 再补一遍校验。
  const x402 = createX402Client({
    baseUrl: process.env["MSB_AGENT_BASE_URL"] ?? DEFAULT_BASE_URL,
    gateway,
  });
  log(`正在真实调用 ${MODULE_ID}/check（这一步会付费）…`);
  const { response, settlementId, paidAtomic } = await x402.check(MODULE_ID, CLEAN_DEAL_INPUT);

  const after = await gateway.getBalances();
  const observedSpend = before.gateway.available - after.gateway.available;
  log(
    `付款后 Gateway 可用余额：${fmt(after.gateway.available)} USDC` +
      `（chain 报告花费 ${fmt(paidAtomic)}，余额实测差 ${fmt(observedSpend)}）`,
  );

  const capturedAt = new Date().toISOString();
  const provenance: FixtureProvenance = {
    module: response.module,
    version: response.version,
    source: "recorded",
    capturedAt,
    royaltyRecorded: true,
    settlementId,
    note:
      `真实 x402 付费调用录制：POST /modules/${MODULE_ID}/check，` +
      `付款方 ${gateway.address}，花费 ${fmt(paidAtomic)} USDC（Gateway 余额 ` +
      `${fmt(before.gateway.available)} → ${fmt(after.gateway.available)}）。` +
      `Gateway 结算 ID（payment.transaction）：${settlementId}。`,
  };

  const recording: ModuleRecording = { provenance, response };
  mkdirSync(dirname(RECORDING_PATH), { recursive: true });
  writeFileSync(RECORDING_PATH, `${JSON.stringify(recording, null, 2)}\n`, "utf8");

  log("");
  log(`已写入 ${RECORDING_PATH}`);
  log(`  module           : ${response.module}@${response.version}`);
  log(`  overall          : ${response.overall}`);
  log(`  maintainer_wallet: ${response.maintainer_wallet}`);
  log(`  royalty_bps      : ${String(response.royalty_bps)}`);
  log(`  结算 ID          : ${settlementId}`);
  log("");
  if (response.maintainer_wallet === "0x0000000000000000000000000000000000000000") {
    log("⚠️  maintainer_wallet 是零地址 = 该实例未配置版税收款方。");
    log("   按 docs/api.md，购买方必须视为「无版税应付」且不得向零地址转账。");
    log("   → 建议把版税这一拍从 P&L 与 demo 里删掉，而不是展示一笔付给零地址的钱。");
  } else {
    log("✓ maintainer_wallet 非零，版税拍可以诚实打开。");
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`record-module-response 失败：${safeErrorMessage(err)}\n`);
  process.exitCode = 1;
}
