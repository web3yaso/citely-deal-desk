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
 * 字段形状照 `ModuleResponse`（合约 §1 线上契约），已跟进上游 2026-07-31 的破坏性
 * 变更：`CheckStatus` 四值（多出 `NOT_APPLICABLE`）、每条 check 带 `basis`、
 * `settlement_constraints.evaluated_check_count`、根级 `engine_version` /
 * `hash_scheme_version`。这是 L1 的输出，不是我们的判定：放行与否由 Policy Engine
 * 从这里的 `settlement_constraints` 与 `overall` 推导（不变量 2），演示脚本自己不会
 * 去改一个字。
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
 * 合成占位哈希。**不是** scheme 2 前像算出来的摘要，也算不出来。
 *
 * 上游 2026-07-31 起把 `evidence_hash` 预映射升到 scheme 2（版本上下文进入前像、
 * `checks` 段从 `{id,result}` 扩为 `{id,result,basis}`），**任何旧值都无法用新引擎
 * 复现**。这里保留一串显眼的 `aaaa…` 正是为了不冒充可复算的真值：谁想拿它做离线
 * 复算校验，会立刻发现它不是哈希，而不是对着一个像模像样的十六进制串怀疑人生。
 */
const PLACEHOLDER_EVIDENCE_HASH = "a".repeat(64);

/**
 * 一份**按新引擎形态构造**的合成响应：3 条适用检查项通过 + 2 条不适用。
 *
 * 为什么不是五条全 `PASS`：上游把「规则未触发」从 `PASS` 里拆成了
 * `NOT_APPLICABLE`（见 `CheckStatus`）。真实调用里任何一笔交易都不可能触发全部
 * 规则，所以"五条全 PASS"在新引擎下根本不会出现——照旧写会让 `--dry-run` 与真实
 * 调用的语义**系统性地不一致**，而"把不适用误当成通过"正是这次变更要消灭的误读。
 *
 * `basis` 的取值不是装饰，逐条都有约束：
 * - `not_applicable`——规则条件未触发（MT-02 / MT-03 两条豁免情形本案不涉及）；
 * - `caller_assertion`——上游**没有连接任何外部注册或许可数据库**，注册号、州牌照
 *   这类非空材料只能标记为调用方自述，不能当成核验过的事实（MT-04 / MT-05）；
 * - `deterministic_threshold`——只依赖请求里的完整数值做确定性比较，不依赖任何
 *   自述文本（MT-01：单笔 12,500 USDC 高于 1,000 USD/人/日的活动门槛）。
 *
 * `evaluated_check_count` 必须等于非 `NOT_APPLICABLE` 的条数（这里 3），因为它现在是
 * **放行判据的一部分**（`blocked=[] && escalated=[] && count > 0`）。填错等于让
 * dry-run 骗过真实结算逻辑，`module-response.test.ts` 把这条钉死了。
 *
 * 仍然选 `overall: "PASS"` 是为了让演示走完 `complete` 主路径；要演示 HOLD/ESCALATE
 * 出口，改 `blocked_check_ids` / `escalated_check_ids` 即可，Policy Engine
 * 会自动收紧 condition，不需要改任何判定代码。
 *
 * ⚠️ `checks[].id` 这里用的是 rubric 的 `MT-0x`，但**真实录制显示 L1 用的是完全
 * 不同的一套 id**（`us-bsa-aml-program`、`us-ny-money-transmitter-license` 等）。
 * 两个命名空间在契约上本来就独立，管线也不靠它们相等——这份合成替身只在
 * 没有录制时兜底，不要拿它的 id 去推断线上形态。线上形态可参考已归档的
 * `recorded/us-msb.scheme1.json`（见 {@link RECORDING_PATH}）。
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
      // 只用 activity + amount_usdc 两个结构化数值判定，不读任何自述文本。
      basis: "deterministic_threshold",
      reason:
        "Declared activity is money_transmission and the 12,500 USDC transfer exceeds the " +
        "USD 1,000 per person per day activity threshold; in scope on the numbers alone.",
      source: "31 CFR § 1010.100(ff)(5)(i)(A)",
    },
    {
      id: "MT-02",
      result: "NOT_APPLICABLE",
      basis: "not_applicable",
      reason:
        "Payment processor exemption not triggered: the materials describe no arrangement to " +
        "facilitate payment for goods or services through a regulated clearance system.",
      source: "31 CFR § 1010.100(ff)(5)(ii)(B)",
    },
    {
      id: "MT-03",
      result: "NOT_APPLICABLE",
      basis: "not_applicable",
      reason:
        "Integral-to-another-service exemption not triggered: no independent non-transfer " +
        "primary service is identified in the materials.",
      source: "31 CFR § 1010.100(ff)(5)(ii)(F)",
    },
    {
      id: "MT-04",
      result: "PASS",
      // 号码格式对不等于号码存在：本服务没有连 FinCEN 注册库，只能记为调用方自述。
      basis: "caller_assertion",
      reason:
        "Caller supplied a well formed FinCEN MSB registration number; not verified against " +
        "the FinCEN registry.",
      source: "31 CFR § 1022.380(a)",
    },
    {
      id: "MT-05",
      result: "PASS",
      basis: "caller_assertion",
      reason:
        "Caller supplied a New York money transmitter licence covering the payer state; " +
        "not verified against NMLS.",
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
    // MT-01 / MT-04 / MT-05 三条被真正评估过；MT-02 / MT-03 不适用，不计入。
    evaluated_check_count: 3,
    evidence_hash: PLACEHOLDER_EVIDENCE_HASH,
  },
  evidence_hash: PLACEHOLDER_EVIDENCE_HASH,
  engine_version: "1.0.0",
  hash_scheme_version: "2",
  disclaimer:
    "输出为基于公开法源整理的检查项状态，不构成法律意见。",
};

/**
 * 真实录制落盘的位置。录制存在时**优先于**上面的合成替身。
 *
 * 当前**没有**可用录制：2026-07-29 那次真实付费调用（`us-msb.scheme1.json`）是
 * 上游破坏性变更之前的 scheme 1 形态，缺 `basis` / `evaluated_check_count` /
 * 两个 version 字段，`assertModuleResponse` 会直接拒收。它没有被删、也**没有被手工
 * 补字段**——往 `source: "recorded"` 的槽位里填编造字段，版税闸就形同虚设了；
 * 只是按 `hash_scheme_version` 分桶改名归档，留作审计与线上形态参考。
 *
 * 重新跑一次 `scripts/record-module-response.ts` 就会在这里写回 scheme 2 的真录制，
 * 届时演示自动切到真值、版税闸自动放行，不用改任何代码。
 */
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
