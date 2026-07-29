import type { DealInput, ModuleId, ModuleResponse } from "./module.js";

/**
 * 一次 x402 采购的完整结果：**内容 + 付款回执**。
 *
 * 为什么不只返回 {@link ModuleResponse}：账本（v2.3 §3.5）的 `{ref, ref_type}` 三态里，
 * `module_fee` 与 `royalty` 两类走 `ref_type: "gateway_receipt"`，`ref` 填的就是
 * Gateway 结算 ID。付款方只有 chain 这一处能拿到它，这里丢掉，账本那一态就没有数据来源。
 */
export interface ModuleCheckResult {
  /** 已校验形状的 Module 响应。 */
  readonly response: ModuleResponse;
  /**
   * Gateway 结算 ID（`GatewayPayResult.transaction`）——账本
   * `ref_type: "gateway_receipt"` 的 `ref` 值。
   *
   * 空字符串在 chain 侧就当付款失败抛掉了，**调用方可以直接信任它非空**。
   */
  readonly settlementId: string;
  /** 实际花费，6 位小数原子单位——账本 `amount_actual` 用它，不许按定价表推算。 */
  readonly paidAtomic: bigint;
}

/**
 * x402 采购客户端：402 → 签名付款 → 重放 → 200 一体完成。
 *
 * 付款走采购钱包私钥（三密钥物理分离，不得复用运营/验证器密钥）。
 * `check` 绝不自动 deposit——余额不足抛可读错误由人工处置。
 */
export interface X402Client {
  /**
   * @param moduleId - 已上线的 Module ID；用 {@link ModuleId} 而不是 `string`，
   *   拼错的 module 名在编译期就该被挡住，而不是花掉一次 402 付款才发现 404。
   * @param dealInput - 合成案件输入
   * @returns Module 响应 + 付款回执（结算 ID 与实付金额）
   */
  check(moduleId: ModuleId, dealInput: DealInput): Promise<ModuleCheckResult>;
}
