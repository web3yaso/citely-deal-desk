/**
 * 出口 3（signal 缺失 → 付费采购消解）真链验证。
 *
 * 这是五出口里**唯一会真实花钱**的路径，也是"按需付费取证"叙事的核心：
 * 判定发现某个 rubric 判定项的 signal 缺失（`gray_data`）→ 引擎路由到出口 3 →
 * 经 x402 **真实付费**向 msb-agent 采购数据 → 合并重跑 → 归入出口 2 或出口 4。
 *
 * 用法：
 * ```
 * # 只做前置检查，一分钱不花（默认）
 * ARC_RPC_URL=https://arc-testnet.drpc.org \
 *   node --import tsx scripts/spike/exit3-procurement.ts
 *
 * # 真实付费跑（us-msb 0.80 USDC/次，一轮消解 1 次）
 * ARC_RPC_URL=https://arc-testnet.drpc.org \
 *   node --import tsx scripts/spike/exit3-procurement.ts --live
 * ```
 *
 * **默认不花钱**是有意的：真付费脚本的默认行为应该是"告诉我会花多少"，
 * 而不是"直接花掉"。`--live` 是那道必须由人按下的闸。
 *
 * 双向对账：跑前跑后各读一次 Gateway 余额，**用余额差核对 chain 报告的
 * `paidAtomic`**——只信调用方自报的金额，等于没有对账。
 */

import {
  checkProcurement,
  itemsNeedingEscalation,
  itemsNeedingProcurement,
  procurementOutcomeFrom,
  routeExit,
  type AdjudicationSummary,
  type ProcurementLimits,
  type RoutingInput,
} from "../../packages/engine/src/routing/index.js";
import { deriveCondition, type PolicyModuleInput } from "../../packages/engine/src/policy/index.js";
import { purchaseLedgerEntries } from "../../packages/engine/src/ledger/purchase.js";
import { LedgerStore } from "../../packages/engine/src/ledger/store.js";
import { openDatabase } from "../../packages/engine/src/db/schema.js";
import { resolveDbPath } from "../../packages/engine/src/db/path.js";
import { formatUsdc6, usdc6, usdc6FromDecimal } from "../../packages/engine/src/util/usdc6.js";
import { loadDotEnvFile } from "../../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../../packages/chain/src/config/redact.js";
import {
  createGatewayClient,
  createX402Client,
  MINIMUM_GATEWAY_BALANCE,
} from "../../packages/chain/src/x402-client.js";
import type { DealInput } from "../../packages/chain/src/types/module.js";
import type { ModuleCheckResult } from "../../packages/chain/src/types/x402.js";

/** us-msb 的 x402 报价（合约 §1 定价表）。 */
const MODULE_PRICE = usdc6FromDecimal("0.80");
/** 单笔上限：比报价留出余量，但远低于 Gateway 余额。 */
const SINGLE_SPEND_CAP = usdc6FromDecimal("1.00");
/** 本案采购预算上限（v2.2 §2.3 资金规划：采购预算 5.00）。 */
const CASE_BUDGET_CAP = usdc6FromDecimal("5.00");
const CASE_ID = "citely-spike-exit3";
const MODULE_ID = "us-msb" as const;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function section(title: string): void {
  write(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

/** 断言并打印。失败即抛——真链脚本不许"看起来跑过了"。 */
function assert(label: string, ok: boolean, detail = ""): void {
  write(`  ${ok ? "✅" : "❌"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) throw new Error(`assertion failed: ${label}`);
}

/**
 * 缺 signal 的案件：把 `fincen_msb_registration` 抽掉。
 *
 * 这正是 rubric MT-04 的 signal 之一（"主体是否为 MSB"的前置事实），
 * 缺了它判定器只能给 `gray_data`——**数据问题，可以买**，而不是法律问题。
 */
function dealWithMissingSignal(): DealInput {
  return {
    deal_id: CASE_ID,
    parties: [
      { role: "payer", country: "US", state: "NY" },
      { role: "payee", country: "SG" },
    ],
    activity: "money_transmission",
    amount_usdc: 12_500,
    monthly_volume_usdc: 480_000,
    evidence: {
      incorporation_country: "SG",
      // fincen_msb_registration 刻意缺席 —— 这就是那个 missing signal。
      compliance_note:
        "Counterparty operates a licensed remittance corridor between the United States and Singapore.",
    },
  };
}

/** 采购前的判定摘要：MT-04 因 signal 缺失落在 `gray_data`。 */
function adjudicationsBeforePurchase(): readonly AdjudicationSummary[] {
  return [
    { item_id: "MT-01", verdict: "confirmed_in_scope" },
    { item_id: "MT-04", verdict: "gray_data", gray_type: "data" },
  ];
}

/** 采购后的判定摘要：数据已合并，MT-04 消解为确定结论。 */
function adjudicationsAfterPurchase(resolved: boolean): readonly AdjudicationSummary[] {
  return [
    { item_id: "MT-01", verdict: "confirmed_in_scope" },
    resolved
      ? { item_id: "MT-04", verdict: "confirmed_in_scope" }
      : // 买了还是灰：标记 procurementExhausted，**不再重复采购**（避免死循环）。
        { item_id: "MT-04", verdict: "gray_data", gray_type: "data", procurementExhausted: true },
  ];
}

function routing(items: readonly AdjudicationSummary[]): RoutingInput {
  return { intake: "ok", expired: false, adjudications: items };
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  loadDotEnvFile(`${process.cwd()}/.env`);

  write(`\n=== 出口 3 真链验证（${live ? "LIVE：会真实花钱" : "PREFLIGHT：不花钱"}）===`);
  write("");
  write("  验证范围说明（避免把本脚本读成比它更强的证据）：");
  write("  · 真实的：x402 付费采购、Gateway 结算 ID、实付金额、账本入账、余额对账、");
  write("            采购三约束、路由决策、不重复采购");
  write("  · **不真实的**：判定 verdict 由 fixture 固定给出，未调用 LLM——");
  write("            OPENAI_MODEL 当前配置的带日期 ID 在 /v1/models 里不存在（见报告）。");
  write("            本脚本验的是「付费取证链路」，不是「判定器判得准不准」。");

  const baseUrl = (process.env["MSB_AGENT_BASE_URL"] ?? "").trim();
  const procurementKey = (process.env["PROCUREMENT_PRIVATE_KEY"] ?? "").trim();
  if (baseUrl === "" || procurementKey === "") {
    throw new Error("MSB_AGENT_BASE_URL 与 PROCUREMENT_PRIVATE_KEY 必须配置");
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/modules/${MODULE_ID}/check`;

  // ── ① 路由：缺 signal → 出口 3 ────────────────────────────────
  section("① 路由：signal 缺失 → 出口 3");
  const before = routing(adjudicationsBeforePurchase());
  const decision1 = routeExit(before);
  write(`  decision=${decision1.exit} chainAction=${decision1.chainAction} actor=${decision1.actor}`);
  assert("路由到 data_gap（出口 3）", decision1.exit === "data_gap");
  assert("出口 3 不产生链上写操作", decision1.chainAction === "none" && decision1.actor === "none");
  const needed = itemsNeedingProcurement(before);
  assert("识别出待采购判定项", needed.length === 1 && needed[0]?.item_id === "MT-04",
    needed.map((i) => i.item_id).join(","));

  // ── ② 采购三约束 ──────────────────────────────────────────────
  section("② 采购三约束（v2.3 §2.1b）");
  const gateway = createGatewayClient(
    procurementKey as `0x${string}`,
    process.env["ARC_RPC_URL"] ?? undefined,
  );
  const balanceBefore = (await gateway.getBalances()).gateway.available;
  write(`  采购钱包=${gateway.address}`);
  write(`  Gateway 余额（跑前）=${formatUsdc6(usdc6(balanceBefore))} USDC`);

  const limits: ProcurementLimits = {
    endpointWhitelist: [endpoint],
    maxSingleSpend: SINGLE_SPEND_CAP,
    gatewayAvailable: usdc6(balanceBefore),
    spentThisCase: usdc6(0n),
    maxPerCase: CASE_BUDGET_CAP,
  };

  const allowed = checkProcurement({ endpoint, amount: MODULE_PRICE }, limits);
  assert("白名单内 + 未超单笔上限 + 余额充足 → 放行", allowed.allowed);

  // 三条约束**逐条单独验证，并断言确切的拒绝原因**。
  // 只断言"被拒了"是不够的：若被另一条约束抢先拦下，这条其实从未被执行到，
  // 测试就是为错误的原因通过的。
  const denialOf = (
    label: string,
    request: { endpoint: string; amount: typeof MODULE_PRICE },
    over: Partial<ProcurementLimits>,
    expected: string,
  ): void => {
    const verdict = checkProcurement(request, { ...limits, ...over });
    const actual = verdict.allowed ? "(allowed)" : verdict.denial;
    assert(`${label} → ${expected}`, actual === expected, `实际 denial=${actual}`);
  };

  denialOf(
    "约束①：未注册端点",
    { endpoint: "https://evil.example/modules/us-msb/check", amount: MODULE_PRICE },
    {},
    "not_whitelisted",
  );
  denialOf(
    "约束②：超单笔上限",
    { endpoint, amount: usdc6FromDecimal("1.01") },
    {},
    "exceeds_single_cap",
  );
  // 余额约束要单独隔离：金额必须**低于**单笔上限、**高于**可用余额，
  // 否则会被约束②抢先拦下（第一版就踩了这个坑）。
  denialOf(
    "约束③：超 Gateway 余额",
    { endpoint, amount: usdc6FromDecimal("0.80") },
    { gatewayAvailable: usdc6FromDecimal("0.50") },
    "insufficient_gateway_balance",
  );
  denialOf(
    "约束④：超本案预算上限",
    { endpoint, amount: MODULE_PRICE },
    { spentThisCase: usdc6FromDecimal("4.50"), maxPerCase: CASE_BUDGET_CAP },
    "exceeds_case_budget",
  );

  assert(
    `Gateway 余额高于最低门槛 ${formatUsdc6(usdc6(MINIMUM_GATEWAY_BALANCE))}`,
    balanceBefore >= MINIMUM_GATEWAY_BALANCE,
    formatUsdc6(usdc6(balanceBefore)),
  );

  // ── ③ 付款失败 → 该腿转 HOLD（mock，不真造失败）──────────────
  section("③ 付款失败 → 该腿转 HOLD");
  const preProcurementModule: PolicyModuleInput = {
    overall: "HOLD",
    settlement_constraints: {
      module: MODULE_ID,
      module_version: "2026.07.1",
      deal_id: CASE_ID,
      valid_until: "2026-12-31T00:00:00Z",
      blocked_check_ids: ["MT-04"],
      escalated_check_ids: [],
      evidence_hash: "00".repeat(32),
    },
  };
  const failed = procurementOutcomeFrom(
    { response: {} as never, settlementId: "", paidAtomic: 0n } as ModuleCheckResult,
    3,
  );
  assert("空结算 ID 判为失败", !failed.ok);
  assert(
    "沿用采购前 Module 结果 → condition 仍为 HOLD（无需特殊代码路径）",
    deriveCondition([preProcurementModule]) === "HOLD",
  );

  if (!live) {
    section("PREFLIGHT 结束");
    write(`  下一步会花费：${formatUsdc6(MODULE_PRICE)} USDC（${MODULE_ID} 一次采购）`);
    write(`  确认无误后加 --live 真实执行。`);
    return;
  }

  // ── ④ 真实付费采购 ────────────────────────────────────────────
  section("④ 真实付费采购（x402）");
  const x402 = createX402Client({ baseUrl, gateway });
  const result = await x402.check(MODULE_ID, dealWithMissingSignal());
  const outcome = procurementOutcomeFrom(result);
  write(`  结算 ID=${outcome.settlementId}`);
  write(`  实付=${formatUsdc6(outcome.paidAtomic)} USDC`);
  write(`  Module=${result.response.module}@${result.response.version} overall=${result.response.overall}`);
  assert("结算 ID 非空", outcome.ok);
  assert("实付金额与报价一致", outcome.paidAtomic === MODULE_PRICE,
    `${formatUsdc6(outcome.paidAtomic)} vs ${formatUsdc6(MODULE_PRICE)}`);

  // ── ⑤ 账本：ref_type = gateway_receipt ────────────────────────
  section("⑤ 账本入账（v2.3 §3.5）");
  const dbPath = resolveDbPath(process.env, { dryRun: false });
  const db = openDatabase(dbPath);
  try {
    const ledger = new LedgerStore(db);
    const accounting = purchaseLedgerEntries({
      caseId: CASE_ID,
      moduleId: MODULE_ID,
      result,
    });
    for (const entry of accounting.entries) ledger.record(entry);
    const moduleFee = accounting.entries[0];
    write(`  库=${dbPath}`);
    write(
      `  账本 ${moduleFee?.account}: ${moduleFee?.direction} ${moduleFee?.category} ` +
        `actual=${formatUsdc6(moduleFee?.amount_actual ?? usdc6(0n))} ` +
        `回执=${moduleFee?.ref} 结算tx=${moduleFee?.settlement_tx ?? "待结算"}`,
    );
    assert("ref_type = gateway_receipt", moduleFee?.ref_type === "gateway_receipt");
    assert("ref = 真实结算 ID", moduleFee?.ref === outcome.settlementId);
    assert("amount_actual = 实付金额", moduleFee?.amount_actual === outcome.paidAtomic);
    assert("settlement_tx 为空（Gateway 批量结算尚未发生）", moduleFee?.settlement_tx === null);
    if (accounting.royalty !== null) {
      write(
        `  版税义务：${formatUsdc6(accounting.royalty.amount)} USDC → ${accounting.royalty.payee}` +
          `（${String(accounting.royalty.bps)} bps，待独立支付后按其自身回执入账）`,
      );
    }
  } finally {
    db.close();
  }

  // ── ⑥ 合并重跑 → 不再重复采购 ─────────────────────────────────
  section("⑥ 数据合并后重跑判定");
  const resolvedRouting = routing(adjudicationsAfterPurchase(true));
  const decision2 = routeExit(resolvedRouting);
  write(`  消解成功 → decision=${decision2.exit} chainAction=${decision2.chainAction}`);
  assert("归入出口 2（高置信）", decision2.exit === "high_confidence");
  assert("不再需要采购", itemsNeedingProcurement(resolvedRouting).length === 0);

  const stillGray = routing(adjudicationsAfterPurchase(false));
  const decision3 = routeExit(stillGray);
  write(`  买了仍灰 → decision=${decision3.exit}（procurementExhausted=true）`);
  assert(
    "**第二轮不再重复采购**（防死循环）",
    itemsNeedingProcurement(stillGray).length === 0,
  );
  // §2.2：出口 3 "→ 归入出口 2 或 4"。消解成功是 2，买了还是灰就是 4——
  // 买都买不到证据的判定项必须升级给人，不能标成"高置信"。
  assert("买了仍灰 → 归入出口 4（升级给人）", decision3.exit === "interpretive_gray", decision3.exit);
  assert(
    "该判定项进入升级清单（要出卷宗与 Review Job）",
    itemsNeedingEscalation(stillGray).some((i) => i.item_id === "MT-04"),
  );

  // ── ⑦ 双向对账 ────────────────────────────────────────────────
  section("⑦ 余额双向对账");
  const balanceAfter = (await gateway.getBalances()).gateway.available;
  const delta = balanceBefore - balanceAfter;
  write(`  跑前=${formatUsdc6(usdc6(balanceBefore))} 跑后=${formatUsdc6(usdc6(balanceAfter))}`);
  write(`  余额差=${formatUsdc6(usdc6(delta))} chain 自报 paidAtomic=${formatUsdc6(outcome.paidAtomic)}`);
  if (delta === outcome.paidAtomic) {
    assert("余额差与自报实付一致", true);
  } else {
    // 不直接判失败：Gateway 批量结算有延迟，余额可能尚未反映这一笔。
    write(
      `  ⚠️ 余额差与自报实付不等。Gateway 是批量结算，扣款可能延迟——` +
        `这不必然是错误，但**必须人工复核**后再写进运行日志。`,
    );
  }

  section("出口 3 验证完成");
  write(`  结算 ID：${outcome.settlementId}`);
  write(`  实付：${formatUsdc6(outcome.paidAtomic)} USDC`);
  write(`  账本：module_fee / gateway_receipt / 待结算\n`);
}

main().catch((err: unknown) => {
  process.stdout.write(`\n✗ 出口 3 验证中止：${safeErrorMessage(err, "")}\n`);
  process.exitCode = 1;
});
