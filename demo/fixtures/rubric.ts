/**
 * 演示用 rubric（合成案件配套）。
 *
 * **它不是法律知识资产**，只是让纵切跑通所需的最小判定项集合：真实 rubric 归
 * `rubrics/`（主导拥有）。`loadDemoRubric()` 会优先读磁盘上的真 rubric，
 * 读不到才退回本文件——这样 rubric 一落地，演示脚本自动切过去，不需要改代码。
 *
 * 免责声明（对外文案红线）：输出为基于公开法源整理的检查项状态，不构成法律意见。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadRubric, parseRubric } from "@citely/engine/rubric";
import type { LoadedRubric } from "@citely/engine/rubric";

/** 真 rubric 的约定位置（仓库根的 `rubrics/`）。 */
export const RUBRICS_DIR = join(import.meta.dirname, "..", "..", "rubrics");

/** 演示 rubric 的 id，与 Module id 对齐便于人读。 */
export const DEMO_RUBRIC_ID = "us-msb";

const DEMO_RUBRIC_RAW = {
  scenario: "us-msb",
  version: "2026.07.1",
  last_verified_date: "2026-07-01",
  // ⚠️ 这是 **rubric 作者**的版税（v2.3 §4.1），与 Module maintainer 的版税
  // 是**两笔不同的钱、两个不同的收款方**，账本上必须分开记：
  //   - rubric 作者版税 → 付给 rubric 的 author.wallet（知识资产的作者）
  //   - Module maintainer 版税 → 付给 /check 响应的 maintainer_wallet（L1 服务维护者）
  // 两者用同一个地址或记成同一笔，都是账目错误而不只是文案问题。
  //
  // 这里用零地址 + 0 bps 表示"未配置版税收款方"，不编造数字。
  author: {
    name: "Citely Demo（随包 fallback，非真 rubric）",
    license: "CC-BY-4.0",
    wallet: "0x0000000000000000000000000000000000000000",
  },
  royalty_bps: 0,
  verdict_states: ["confirmed_in_scope", "confirmed_exempt", "gray_interpretive"],
  items: [
    {
      id: "msb-registration",
      question: "Is the counterparty registered with FinCEN as a money services business?",
      signals: ["fincen_msb_registration", "incorporation_country"],
      acceptance_criteria: ["A FinCEN MSB registration number is present in the evidence"],
      common_rejection_reasons: ["No registration number", "Registration number expired"],
      source: "31 CFR § 1010.100(ff)",
      confidence_rule: "high when a registration number is on file",
    },
    {
      id: "msb-state-licensing",
      question: "Does the payer state require a money transmitter licence for this corridor?",
      signals: ["state_licenses", "activity"],
      acceptance_criteria: ["A licence covering the payer state is present"],
      common_rejection_reasons: ["Licence covers a different state", "No licence listed"],
      source: "NY Banking Law § 641",
      confidence_rule: "high when the licence state matches the payer state",
    },
  ],
} as const;

/** 已加载的 rubric 及其来源。来源要能打印出来，否则没人知道演示到底用的哪份。 */
export interface DemoRubric {
  readonly loaded: LoadedRubric;
  /** 磁盘上的真 rubric 路径，或 `"随包演示 rubric（rubrics/ 尚未落地）"`。 */
  readonly source: string;
  /** 是否用的是 `rubrics/` 下的真 rubric。 */
  readonly isReal: boolean;
}

/**
 * 加载演示用 rubric。
 *
 * @returns 磁盘上的真 rubric；不存在时退回随包演示 rubric
 */
export function loadDemoRubric(): DemoRubric {
  const onDisk = join(RUBRICS_DIR, `${DEMO_RUBRIC_ID}.json`);
  if (existsSync(onDisk)) {
    return { loaded: loadRubric(onDisk), source: onDisk, isReal: true };
  }
  return {
    loaded: { id: DEMO_RUBRIC_ID, rubric: parseRubric(DEMO_RUBRIC_RAW) },
    source: "随包演示 rubric（rubrics/ 尚未落地）",
    isReal: false,
  };
}
