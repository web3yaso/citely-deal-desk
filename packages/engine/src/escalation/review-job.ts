/**
 * Review Job 模板（v2.3 §2.2 出口 4）。
 *
 * 出口 4 是"解释性 gray"——法律问题，买数据没用，只能升级给人。该腿标 ESCALATE，
 * 随 SA 一起 `submit` 的还有两样东西：**会谈卷宗**（见 `briefing.ts`）与本文件的
 * **Review Job 模板**。
 *
 * ## `client` 必须是 Marketplace，不是 Citely
 *
 * v2.3 §2.3 资金规划：「Review 保证金释放路径：退回 Marketplace → Marketplace
 * 注资 Review Job，**专家的钱永远来自委托人**」。
 *
 * 这和"客户资金永不进入我方地址"（不变量 3）是同一个原则的两面：我们既不代收
 * 客户的结算资金，也不代付专家的酬金。模板里把 `client` 填成 Citely 就等于
 * 让我方成为专家费用的付款人——那是一条完全不同的、需要牌照讨论的业务。
 *
 * ⚠️ 8183 的 `createJob(provider, evaluator, expiredAt, description, hook)`
 * **没有 `client` 参数**——`client` 就是 `msg.sender`。所以模板里的 `client`
 * 字段语义是"**必须由这个地址发起 createJob 交易**"，不是一个传给合约的入参。
 * 这个区别写在类型注释里，免得实现方照着字段名往 calldata 里塞。
 */

import type { Address } from "viem";

import { usdc6ToAtomicString } from "../util/usdc6.js";
import type { Usdc6 } from "../util/usdc6.js";

/** 我方一律传零地址（合约 §2：每个写函数末尾的 `optParams` 传 `0x`，`hook` 传 0 地址）。 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** 模板类型标识，便于消费方分辨（将来可能有别的子 Job 形态）。 */
export const REVIEW_JOB_TEMPLATE_KIND = "erc8183_review_job";

/**
 * Review Job 模板。
 *
 * **刻意用 `type` 而不是 `interface`**：type alias 有隐式索引签名，可以直接赋给
 * `Readonly<Record<string, unknown>>`，这样 SA 的消费方（verifier/marketplace）
 * 即使仍按开放记录读也不会被破坏。
 *
 * 所有金额与大整数都是**十进制字符串**——它要进 SA 的 JSON，而 JSON 没有 bigint。
 */
export type ReviewJobTemplate = {
  readonly kind: typeof REVIEW_JOB_TEMPLATE_KIND;
  /**
   * **必须由这个地址发起 `createJob`**（它就是 8183 的 `client` = `msg.sender`）。
   * 恒为 Marketplace：专家的钱来自委托人。
   */
  readonly client: Address;
  /** `createJob` 入参：承接评审的一方（专家/受托方）。 */
  readonly provider: Address;
  /** `createJob` 入参：评审结果的裁定方。 */
  readonly evaluator: Address;
  /** `createJob` 入参 `expiredAt`，Unix 秒的十进制字符串。 */
  readonly expired_at_unix: string;
  /** 同一时刻的 ISO8601 UTC，纯粹给人读（两者必须指向同一时刻）。 */
  readonly expires_at: string;
  /** `createJob` 入参 `description`。措辞受 SA 措辞纪律约束。 */
  readonly description: string;
  /** `createJob` 入参 `hook`，我方恒为零地址。 */
  readonly hook: Address;
  /** 保证金金额，最小单位十进制字符串。由 `client`（Marketplace）注资。 */
  readonly deposit_nominal: string;
  /** 触发本次升级的 rubric 判定项 id（确定性数据，不是 LLM 生成）。 */
  readonly escalated_item_ids: readonly string[];
};

/** {@link buildReviewJobTemplate} 的参数。 */
export interface BuildReviewJobTemplateParams {
  /** Marketplace 地址——**委托人**，由它注资并发起 createJob。 */
  readonly client: Address;
  readonly provider: Address;
  readonly evaluator: Address;
  /** 评审截止时刻。 */
  readonly expiresAt: Date;
  /** 保证金（v2.3 §2.3 资金规划：Review 保证金 2.00）。 */
  readonly deposit: Usdc6;
  /** 被升级的判定项 id，来自 Policy/路由层的确定性结论。 */
  readonly escalatedItemIds: readonly string[];
  /** 覆盖默认 description。 */
  readonly description?: string;
}

/** `client` 与 `provider` 是同一个地址——委托人不能同时是受托方。 */
export class InvalidReviewJobRolesError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidReviewJobRolesError";
  }
}

function defaultDescription(itemIds: readonly string[]): string {
  // 措辞纪律：陈述"需要人工复核哪些判定项"，不表达任何放款授权。
  const items = itemIds.length === 0 ? "(none)" : itemIds.join(", ");
  return `Interpretive review requested for rubric items: ${items}. Outputs are check-item statuses compiled from public legal sources and do not constitute legal advice.`;
}

/**
 * 构造 Review Job 模板。
 *
 * @param params - 角色地址、截止时刻、保证金与被升级的判定项
 * @returns 可直接放进 SA `legs[].escalation.review_job_template` 的模板
 * @throws {InvalidReviewJobRolesError} 角色地址冲突，或 client 为零地址
 */
export function buildReviewJobTemplate(
  params: BuildReviewJobTemplateParams,
): ReviewJobTemplate {
  const client = params.client.toLowerCase();
  if (client === ZERO_ADDRESS) {
    // 零地址 client = 没人注资 = 这个模板是废的。宁可建不出来。
    throw new InvalidReviewJobRolesError("review job client must not be the zero address");
  }
  if (client === params.provider.toLowerCase()) {
    throw new InvalidReviewJobRolesError(
      "review job client and provider must differ (the principal cannot also be the reviewer)",
    );
  }

  const expiredAtUnix = Math.floor(params.expiresAt.getTime() / 1000);
  return {
    kind: REVIEW_JOB_TEMPLATE_KIND,
    client: params.client,
    provider: params.provider,
    evaluator: params.evaluator,
    expired_at_unix: String(expiredAtUnix),
    // 由 unix 秒回算，保证两个字段指向同一时刻（不是各自取一次 now）。
    expires_at: new Date(expiredAtUnix * 1000).toISOString(),
    description: params.description ?? defaultDescription(params.escalatedItemIds),
    hook: ZERO_ADDRESS,
    deposit_nominal: usdc6ToAtomicString(params.deposit),
    escalated_item_ids: [...params.escalatedItemIds],
  };
}

/** 运行期形状校验，供验证器第 3 检直接复用（它不必再手写一遍）。 */
export function isReviewJobTemplate(value: unknown): value is ReviewJobTemplate {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    t["kind"] === REVIEW_JOB_TEMPLATE_KIND &&
    typeof t["client"] === "string" &&
    typeof t["provider"] === "string" &&
    typeof t["evaluator"] === "string" &&
    typeof t["expired_at_unix"] === "string" &&
    typeof t["expires_at"] === "string" &&
    typeof t["description"] === "string" &&
    typeof t["hook"] === "string" &&
    typeof t["deposit_nominal"] === "string" &&
    Array.isArray(t["escalated_item_ids"]) &&
    t["escalated_item_ids"].every((id) => typeof id === "string")
  );
}
