/**
 * L1 Module 响应的**合成替身**，仅供 `--dry-run` 离线复现。
 *
 * ⚠️ **诚实标注：这不是一次真实调用的录制**，而是照 `ModuleResponse` 形状
 * 手工构造的合成数据。真实录制要等 x402 首次成功调用 msb-agent 之后回填
 * （届时把本文件换成真响应即可，消费方不用改）。**非 dry-run 一律走真实
 * msb-agent**，这份替身绝不会被用上（`run-vertical-slice.ts` 里是两条互斥分支）。
 *
 * `--dry-run` 的定义是"不发链上交易、不付费"，而 `POST /modules/:id/check`
 * 是 x402 付费端点——所以离线跑必须有一份替身，否则 dry-run 根本无法离线。
 *
 * 字段形状照 `ModuleResponse`（合约 §1 线上契约）。这是 L1 的输出，不是我们的判定：
 * `PASS/HOLD/ESCALATE` 由 Policy Engine 从这里的 `settlement_constraints` 与
 * `overall` 推导（不变量 2），演示脚本自己不会去改一个字。
 */

import type { ModuleResponse } from "@citely/chain";

/** 合成响应的时间戳，写死是为了让离线复现逐字节可重复。 */
export const RECORDED_AT = "2026-07-27T12:00:00Z";

/**
 * 一份"全部检查项通过"的合成响应。
 *
 * 选 PASS 是为了让演示走完 `complete` 主路径；要演示 HOLD/ESCALATE
 * 出口，改 `blocked_check_ids` / `escalated_check_ids` 即可，Policy Engine
 * 会自动收紧 condition，不需要改任何判定代码。
 *
 * `checks[].id` 用 `rubrics/us-msb.json` 的判定项 id，让演示叙事前后一致；
 * 注意这两个 id 命名空间在契约上是独立的，管线里也不靠它们相等。
 */
export const RECORDED_MODULE_RESPONSE: ModuleResponse = {
  module: "us-msb",
  version: "2026.07.1",
  updated_at: RECORDED_AT,
  maintainer_wallet: "0x000000000000000000000000000000000000dEaD",
  royalty_bps: 250,
  checks: [
    {
      id: "MT-01",
      result: "PASS",
      reason: "Counterparty accepts and transmits value on behalf of the public.",
      source: "31 CFR § 1010.100(ff)(5)(i)(A)",
    },
    {
      id: "MT-02",
      result: "PASS",
      reason: "Activity is not limited to payment processing under the FinCEN exemption.",
      source: "31 CFR § 1010.100(ff)(5)(ii)(B)",
    },
    {
      id: "MT-03",
      result: "PASS",
      reason: "Counterparty is not acting solely as an agent of the payee.",
      source: "31 CFR § 1010.100(ff)(5)(ii)(F)",
    },
    {
      id: "MT-04",
      result: "PASS",
      reason: "FinCEN MSB registration number present and well formed.",
      source: "31 CFR § 1022.380(a)",
    },
    {
      id: "MT-05",
      result: "PASS",
      reason: "State money transmitter licence on file covers the payer state.",
      source: "Uniform Money Services Act § 201",
    },
  ],
  overall: "PASS",
  settlement_constraints: {
    module: "us-msb",
    module_version: "2026.07.1",
    deal_id: "citely-demo-0001",
    valid_until: "2026-08-27T12:00:00Z",
    blocked_check_ids: [],
    escalated_check_ids: [],
    evidence_hash: "a".repeat(64),
  },
  evidence_hash: "a".repeat(64),
  disclaimer:
    "输出为基于公开法源整理的检查项状态，不构成法律意见。",
};
