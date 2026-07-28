import type { DealInput, ModuleResponse } from "./module.js";

/**
 * x402 采购客户端：402 → 签名付款 → 重放 → 200 一体完成。
 *
 * 付款走采购钱包私钥（三密钥物理分离，不得复用运营/验证器密钥）。
 * `check` 绝不自动 deposit——余额不足抛可读错误由人工处置。
 */
export interface X402Client {
  check(moduleId: string, dealInput: DealInput): Promise<ModuleResponse>;
}
