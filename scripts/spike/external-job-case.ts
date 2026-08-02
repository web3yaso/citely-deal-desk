/**
 * 演示 UI 链路的**无浏览器彩排**：脚本扮演浏览器钱包那一侧，逐字走 UI 的调用序列。
 *
 * ```
 * GET  /app/api/config
 * POST /app/api/encode createJob   → 钱包签发 → receipt → topics[1] 取 jobId
 * POST /app/api/jobs/:id/set-budget（服务端 provider 钥）
 * POST /app/api/encode approve/fund → 钱包签发
 * POST /cases（带 job_id，绕过 x402 门：托管即付款）
 * GET  /cases/:id → snapshot 成形
 * ```
 *
 * **为什么用 encode 端点而不直接调 jobClient**：彩排的对象是 UI 将要走的那条
 * HTTP 路径本身——encode 出来的 calldata、事件 topic、set-budget 的握手顺序，
 * 每一环都可能单独坏，绕过它们等于什么都没彩排。
 *
 * 前置：本地服务已按 README 起好（X402_SELL_MODE=off 不影响本链路——
 * 带 job_id 的请求本来就不走 x402 门）。
 *
 * 用法：
 *   node --import tsx scripts/spike/external-job-case.ts [--base http://localhost:8899]
 */
import { ENV_KEYS, loadDotEnvFile, optionalEnv, readPrivateKey } from "../../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../../packages/chain/src/config/redact.js";
import type { Hex } from "../../packages/chain/src/types/viem.js";
import { createChainClients, type RpcConfig } from "../../packages/chain/src/wallet.js";

const DEFAULT_BASE = "http://localhost:8899";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function api<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, options);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${path} → HTTP ${String(response.status)}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body as T;
}

function postJson(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../../.env", import.meta.url).pathname);
  const argv = process.argv.slice(2);
  const base = flagValue(argv, "--base") ?? DEFAULT_BASE;

  const rpcUrl = optionalEnv(process.env, ENV_KEYS.rpcUrl);
  if (rpcUrl === undefined) throw new Error(`未设置 ${ENV_KEYS.rpcUrl}`);
  // 主备都给：两家公共 RPC 都会限流且方向不固定（testnet-run-log 实测记录）。
  const fallbackUrl = optionalEnv(process.env, ENV_KEYS.rpcUrlFallback);
  const rpc: RpcConfig =
    fallbackUrl === undefined ? { primaryUrl: rpcUrl } : { primaryUrl: rpcUrl, fallbackUrl };
  // 彩排里"浏览器钱包"由 marketplace 钥扮演——正是演示要移交给真钱包的那个角色。
  const { walletClient, publicClient } = createChainClients(
    "marketplace",
    readPrivateKey(process.env, ENV_KEYS.marketplaceKey),
    rpc,
  );
  write(`client 钱包（彩排替身）：${walletClient.account.address}`);

  // ── 1. config ────────────────────────────────────────────────────────────
  const cfg = await api<{
    job_contract: `0x${string}`;
    case_budget_atomic: string;
    job_created_topic: string;
    min_expiry_seconds: number;
  }>(base, "/app/api/config");
  write(`[1/6] config：escrow=${cfg.job_contract} budget=${cfg.case_budget_atomic} atomic`);

  const sendEncoded = async (label: string, tx: { to: `0x${string}`; data: Hex }): Promise<Hex> => {
    const txHash = await walletClient.sendTransaction({ to: tx.to, data: tx.data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`${label} 交易 revert：${txHash}`);
    write(`  ${label} tx=${txHash}`);
    return txHash;
  };

  // ── 2. createJob（UI 签名 1）─────────────────────────────────────────────
  const expiredAt = Math.floor(Date.now() / 1000) + Math.max(cfg.min_expiry_seconds + 300, 1800);
  const createTx = await api<{ to: `0x${string}`; data: Hex }>(
    base,
    "/app/api/encode",
    postJson({ action: "createJob", params: { expired_at: String(expiredAt) } }),
  );
  const createHash = await sendEncoded("createJob", createTx);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  const created = receipt.logs.find(
    (log: { address: string; topics: readonly string[] }) =>
      log.address.toLowerCase() === cfg.job_contract.toLowerCase() &&
      log.topics[0] === cfg.job_created_topic,
  );
  if (created?.topics[1] === undefined) throw new Error("receipt 里没有 JobCreated——topic 或合约地址对不上");
  const jobId = BigInt(created.topics[1]).toString();
  write(`[2/6] createJob：jobId=${jobId}（topics[1]，与 UI 同一取法）`);

  // ── 3. setBudget（服务端 provider 钥）────────────────────────────────────
  const budget = await api<{ tx_hash: string }>(base, `/app/api/jobs/${jobId}/set-budget`, {
    method: "POST",
  });
  write(`[3/6] set-budget：tx=${budget.tx_hash}`);

  // ── 4. approve + fund（UI 签名 2、3）─────────────────────────────────────
  const approveTx = await api<{ to: `0x${string}`; data: Hex }>(
    base,
    "/app/api/encode",
    postJson({ action: "approve", params: {} }),
  );
  await sendEncoded("approve", approveTx);
  const fundTx = await api<{ to: `0x${string}`; data: Hex }>(
    base,
    "/app/api/encode",
    postJson({ action: "fund", params: { job_id: jobId } }),
  );
  await sendEncoded("fund", fundTx);
  write(`[4/6] 注资完成：${cfg.case_budget_atomic} atomic 已进 escrow`);

  // ── 5. POST /cases 带 job_id ─────────────────────────────────────────────
  const dealId = `rehearsal-${Date.now().toString(36)}`;
  const caseBody = {
    deal_id: dealId,
    parties: [
      { role: "payer", country: "US", state: "NY" },
      { role: "payee", country: "SG" },
    ],
    activity: "money_transmission",
    amount_usdc: 12_500,
    // 证据面与 demo fixture（CLEAN_DEAL_INPUT）逐字段对齐：signal 缺一个，
    // 判定就滑向 gray → 出口 4，而 HTTP 服务没接出口 4 的 escalation 配置。
    evidence: {
      incorporation_country: "SG",
      fincen_msb_registration: "31000012345678",
      state_licenses: ["NY-MT-2024-0917"],
      aml_program_last_reviewed: "2026-03-14",
      transaction_monitoring: true,
      compliance_note:
        "Counterparty operates a licensed remittance corridor between the United States and Singapore. " +
        "Onboarding pack contains incorporation documents, a FinCEN MSB registration number and " +
        "two years of transaction monitoring reports.",
    },
    monthly_volume_usdc: 480_000,
    settlement: {
      party: "payee",
      payee: "0x000000000000000000000000000000000000bEEF",
      amount_usdc: "12500.00",
    },
    expires_at: new Date(expiredAt * 1000).toISOString(),
    job_id: jobId,
  };
  write(`[5/6] POST /cases（deal_id=${dealId}，真链 + 真采购 + 真判定，等一两分钟…）`);
  const result = await api<{ routing: { exit: string }; sa_hash: string; replayed: boolean }>(
    base,
    "/cases",
    postJson(caseBody),
  );
  write(`  exit=${result.routing.exit} sa_hash=${result.sa_hash} replayed=${String(result.replayed)}`);

  // ── 6. 详情页数据 ────────────────────────────────────────────────────────
  const record = await api<{ state: string; job_id: string | null; snapshot: unknown }>(
    base,
    `/cases/${dealId}`,
  );
  if (record.job_id !== jobId) throw new Error(`案件绑定的 job ${String(record.job_id)} ≠ 彩排建的 ${jobId}`);
  if (record.snapshot === null) throw new Error("snapshot 为空——详情页会没东西可渲染");
  write(`[6/6] GET /cases/${dealId}：state=${record.state}，snapshot 成形`);
  write(`EXTERNAL-JOB-CASE OK：jobId=${jobId} case=${dealId}`);
  write(`详情页：${base}/app#/case/${dealId}`);
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`EXTERNAL-JOB-CASE FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
