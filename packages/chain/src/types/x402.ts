import type { DealInput, ModuleId, ModuleResponse } from "./module.js";

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
   */
  check(moduleId: ModuleId, dealInput: DealInput): Promise<ModuleResponse>;
}
