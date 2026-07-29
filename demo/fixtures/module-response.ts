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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertModuleResponse } from "@citely/chain";
import type { ModuleResponse } from "@citely/chain";

/** 合成响应的时间戳，写死是为了让离线复现逐字节可重复。 */
export const RECORDED_AT = "2026-07-27T12:00:00Z";

/**
 * 本 fixture 的**来源标注**。没有来源标注的"录制快照"，和编造没有区别。
 *
 * 逐字段说明哪些是真的、哪些是构造的——因为这份 fixture 是**混合**的：
 * 形状照线上契约，检查项与法源照 `rubrics/us-msb.json`，
 * 但**没有任何一个字段来自真实的 200 响应**。
 */
export interface FixtureProvenance {
  readonly module: string;
  readonly version: string;
  /** 数据怎么来的。 */
  readonly source: "synthetic" | "recorded";
  /** `recorded` 时是抓取时刻；`synthetic` 时是构造时刻。 */
  readonly capturedAt: string;
  /**
   * `maintainer_wallet` / `royalty_bps` 是否来自真实响应。
   *
   * **为 `false` 时任何版税行都不许渲染**——见 {@link assertRoyaltyRenderable}。
   */
  readonly royaltyRecorded: boolean;
  /**
   * Gateway 支付回执 ID（`payment.transaction`）。
   *
   * **账本的 `module_fee` / `royalty` 两类目必须用它做 `ref`**（v2.3 §3.5：
   * x402 是链下授权，批量结算前没有 txHash）。拿不到它就渲染不出这两行——
   * 所以它不是"锦上添花的元数据"，是这两行存在的前提。
   *
   * 早期录制没抓这个字段，故为可选；没有它时相关账本行**不渲染**，不编造。
   */
  readonly settlementId?: string;
  readonly note: string;
}

/** {@link SYNTHETIC_MODULE_RESPONSE} 的来源标注。 */
export const MODULE_RESPONSE_PROVENANCE: FixtureProvenance = {
  module: "us-msb",
  version: "2026.07.1",
  source: "synthetic",
  capturedAt: RECORDED_AT,
  royaltyRecorded: false,
  note:
    "手工构造，非真实 200 响应。版税两字段按 docs/api.md 的「无版税」编码" +
    "（零地址 + 0 bps），因为线上真实值需要一次付费 /check 调用才能取得，尚未取得。",
};

/** 版税数据不可信却试图使用。 */
export class UnrecordedRoyaltyError extends Error {
  public constructor(provenance: FixtureProvenance) {
    super(
      `refusing to render a royalty line from ${provenance.source} fixture ` +
        `(${provenance.module}@${provenance.version}): maintainer_wallet/royalty_bps are not recorded. ` +
        "Record a real /check response first, or drop the royalty line entirely.",
    );
    this.name = "UnrecordedRoyaltyError";
  }
}

/**
 * 渲染版税行之前必须过的闸。
 *
 * 存在的理由：`ModuleResponse` 类型要求 `maintainer_wallet` 与 `royalty_bps`
 * 必填，所以**没法把这两个字段删掉**——只能保证它们不被当成真数据用。
 * 演示里出现一笔付给未经核实地址的"版税"，会让人怀疑整个 P&L 都是编的，
 * 代价远大于少一拍叙事。
 *
 * @param provenance - fixture 的来源标注
 * @throws {UnrecordedRoyaltyError} 版税字段并非来自真实响应
 */
export function assertRoyaltyRenderable(provenance: FixtureProvenance): void {
  if (!provenance.royaltyRecorded) throw new UnrecordedRoyaltyError(provenance);
}

/**
 * 一份"全部检查项通过"的合成响应。
 *
 * 选 PASS 是为了让演示走完 `complete` 主路径；要演示 HOLD/ESCALATE
 * 出口，改 `blocked_check_ids` / `escalated_check_ids` 即可，Policy Engine
 * 会自动收紧 condition，不需要改任何判定代码。
 *
 * ⚠️ `checks[].id` 这里用的是 rubric 的 `MT-0x`，但**真实录制显示 L1 用的是完全
 * 不同的一套 id**（`us-bsa-aml-program`、`us-ny-money-transmitter-license` 等）。
 * 两个命名空间在契约上本来就独立，管线也不靠它们相等——这份合成替身只在
 * 没有录制时兜底，不要拿它的 id 去推断线上形态。真值见 `recorded/us-msb.json`。
 */
export const SYNTHETIC_MODULE_RESPONSE: ModuleResponse = {
  module: "us-msb",
  version: "2026.07.1",
  updated_at: RECORDED_AT,
  // ⚠️ 这两个字段**不是**真实值，见 MODULE_RESPONSE_PROVENANCE。
  // 按 docs/api.md：零地址 = "该实例未配置版税收款方"，购买方**必须**视为
  // "无版税应付"且**不得**向零地址转账。所以这是"无版税"的**正确编码**，
  // 而不是又一个编造的数——编造的 0x…dEaD + 250 bps 会让人以为真有这笔钱。
  maintainer_wallet: "0x0000000000000000000000000000000000000000",
  royalty_bps: 0,
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

/** 真实录制落盘的位置。录制存在时**优先于**上面的合成替身。 */
export const RECORDING_PATH = join(import.meta.dirname, "recorded", "us-msb.json");

/** 一次录制：来源标注 + 完整响应。 */
export interface ModuleRecording {
  readonly provenance: FixtureProvenance;
  readonly response: ModuleResponse;
}

/** 录制文件损坏或形状不符。 */
export class RecordingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RecordingError";
  }
}

/**
 * 取演示要用的 Module 响应。
 *
 * 优先用磁盘上的**真实录制**；没有录制才退回合成替身，并保留
 * `royaltyRecorded: false` 让版税闸继续挡着。这样 `scripts/record-module-response.ts`
 * 一跑完，演示自动切到真值，不需要改任何代码。
 *
 * 录制回来的响应仍要过 chain 的 `assertModuleResponse` 校验——
 * 落过盘的数据不等于可信数据，文件可能被手改坏。
 *
 * @param path - 录制文件路径，默认 {@link RECORDING_PATH}（注入是为了可测）
 * @returns 响应与其来源标注
 * @throws {RecordingError} 录制文件存在但不可用（**不静默退回合成数据**：
 *   那会让人以为在用真值）
 */
export function loadModuleResponse(path: string = RECORDING_PATH): ModuleRecording {
  if (!existsSync(path)) {
    return { provenance: MODULE_RESPONSE_PROVENANCE, response: SYNTHETIC_MODULE_RESPONSE };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RecordingError(`recording at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new RecordingError(`recording at ${path} must be an object`);
  }
  const rec = raw as { provenance?: unknown; response?: unknown };
  const response = assertModuleResponse(rec.response);
  const provenance = rec.provenance as FixtureProvenance | undefined;
  if (provenance === undefined || provenance.source !== "recorded") {
    // 合成数据冒充录制会在这里被挡住——否则版税闸就形同虚设。
    throw new RecordingError(`recording at ${path} must carry provenance.source === "recorded"`);
  }
  if (!provenance.royaltyRecorded) {
    throw new RecordingError(`recording at ${path} must set provenance.royaltyRecorded = true`);
  }
  return { provenance, response };
}
