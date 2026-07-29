/**
 * Funded 之后的**五出口路由**（v2.3 §2.2，路由逻辑核心）。
 *
 * | # | 出口 | 触发 | 链上动作 |
 * |---|---|---|---|
 * | 1 | 受理失败 | 材料不可解析 / 超出 rubric 范围 | 验证器在 **Funded 态** `reject` |
 * | 2 | 高置信 | 落入或豁免均自动出报告 | `submit` → 三检 → `complete` |
 * | 3 | signal 缺失 | **数据问题**，可购买消解 | x402 付费采购 → 合并重跑 → 归入 2 或 4 |
 * | 4 | 解释性 gray | **法律问题**，买数据无用 | 该腿标 ESCALATE + 卷宗 + Review Job，随 SA `submit` |
 * | 5 | 超时 | expiredAt 已过未决 | client `claimRefund` |
 *
 * **`gray_type` 是出口 3 与 4 的唯一分支依据**（§2.2 末句）——判定器 schema 里
 * 那个字段的全部意义就在这里。`data` = 数据问题，买得到；`interpretive` = 法律问题，
 * 买数据没用，只能升级给人。
 *
 * 本文件是**纯函数**：不发请求、不写库、不 await。链上动作只是"该做什么"的描述，
 * 由调用方交给 chain/verifier 去执行。
 */

import type { GrayType, Verdict } from "../adjudicator/schema.js";

/** 五个出口。 */
export type CaseExit =
  | "intake_failed"
  | "high_confidence"
  | "data_gap"
  | "interpretive_gray"
  | "timeout";

/** 出口对应的链上动作。`none` = 这个出口不产生链上写操作。 */
export type ExitChainAction = "reject" | "submit" | "claimRefund" | "none";

/** 谁去做那个动作（角色映射见合约 §2.1）。 */
export type ExitActor = "verifier" | "operator" | "client" | "none";

export interface ExitDecision {
  readonly exit: CaseExit;
  readonly chainAction: ExitChainAction;
  readonly actor: ExitActor;
  /** 人读理由，进卷宗与日志（不含材料内容）。 */
  readonly reason: string;
}

/** 受理结论（沙箱与 rubric 覆盖检查的产物，不是判定器产物）。 */
export type IntakeStatus = "ok" | "unparsable" | "out_of_rubric_scope";

/** 一条判定项的路由相关摘要。 */
export interface AdjudicationSummary {
  readonly item_id: string;
  readonly verdict: Verdict;
  readonly gray_type?: GrayType;
  /**
   * 该数据缺口是否**已经过采购尝试且仍未消解**。
   * `false` = 还没买过，应该走出口 3 去买；`true` = 买过了还是缺，不再重复买。
   */
  readonly procurementExhausted?: boolean;
}

export interface RoutingInput {
  readonly intake: IntakeStatus;
  /** 链上 `expiredAt` 是否已过（轮询得来）。 */
  readonly expired: boolean;
  readonly adjudications: readonly AdjudicationSummary[];
}

/**
 * `gray_type` → 出口。**出口 3 与 4 的唯一分支点**，单独成函数以便被直接测试。
 *
 * @param grayType - 判定器给出的灰色类型；`undefined` = 不是灰色判定
 * @returns 对应出口；非灰色返回 `null`
 */
export function exitForGrayType(grayType: GrayType | undefined): CaseExit | null {
  if (grayType === "data") return "data_gap";
  if (grayType === "interpretive") return "interpretive_gray";
  return null;
}

/** 该条判定是否是"还能靠买数据消解"的缺口。 */
function isOpenDataGap(item: AdjudicationSummary): boolean {
  return exitForGrayType(item.gray_type) === "data_gap" && item.procurementExhausted !== true;
}

function isInterpretive(item: AdjudicationSummary): boolean {
  return exitForGrayType(item.gray_type) === "interpretive_gray";
}

/**
 * 路由到五出口之一。
 *
 * **优先级是有意排定的，不是巧合**：
 *
 * 1. **超时压倒一切**——`claimRefund` 是 permissionless 的（合约 §2.3），
 *    过了 `expiredAt` 谁都能触发退款，链上资金可能已经退回。这时候再去
 *    `submit` 只会得到一个 revert，所以必须最先判。
 * 2. **受理失败次之**——材料根本读不了/超出 rubric 范围时，后面那些判定结果
 *    要么不存在要么不可信，不该参与路由。
 * 3. **数据缺口优先于解释性 gray**——出口 3 是"可消解"的中间态，
 *    §2.2 明确写它"→ 数据合并重跑 → 归入出口 2 或 4"。先把能买的买了再定终局，
 *    否则会把一个本可以变成 PASS 的案件过早升级给人。
 *    已经买过仍未消解的（`procurementExhausted`）不再算作开放缺口，避免死循环。
 * 4. 剩下有解释性 gray → 出口 4；都没有 → 出口 2。
 *
 * @param input - 受理结论、超时标志、各判定项摘要
 * @returns 出口与对应的链上动作
 */
export function routeExit(input: RoutingInput): ExitDecision {
  if (input.expired) {
    return {
      exit: "timeout",
      chainAction: "claimRefund",
      actor: "client",
      reason: "expiredAt has passed before settlement (v2.3 §2.2 exit 5)",
    };
  }

  if (input.intake !== "ok") {
    return {
      exit: "intake_failed",
      chainAction: "reject",
      actor: "verifier",
      reason: `intake failed: ${input.intake} (v2.3 §2.2 exit 1; verifier rejects in Funded state)`,
    };
  }

  const openGaps = input.adjudications.filter(isOpenDataGap);
  if (openGaps.length > 0) {
    return {
      exit: "data_gap",
      chainAction: "none",
      actor: "none",
      reason: `${String(openGaps.length)} item(s) need purchasable data (v2.3 §2.2 exit 3)`,
    };
  }

  const interpretive = input.adjudications.filter(isInterpretive);
  if (interpretive.length > 0) {
    return {
      exit: "interpretive_gray",
      chainAction: "submit",
      actor: "operator",
      reason: `${String(interpretive.length)} item(s) are interpretive gray; escalate and ship with the SA (v2.3 §2.2 exit 4)`,
    };
  }

  return {
    exit: "high_confidence",
    chainAction: "submit",
    actor: "operator",
    reason: "all items resolved without open gaps (v2.3 §2.2 exit 2)",
  };
}

/** 出口 3 需要采购的判定项（调用方据此逐条发起 x402 采购）。 */
export function itemsNeedingProcurement(
  input: RoutingInput,
): readonly AdjudicationSummary[] {
  return input.adjudications.filter(isOpenDataGap);
}

/** 出口 4 需要升级的判定项（调用方据此生成卷宗与 Review Job 模板）。 */
export function itemsNeedingEscalation(
  input: RoutingInput,
): readonly AdjudicationSummary[] {
  return input.adjudications.filter(isInterpretive);
}
