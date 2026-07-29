/**
 * viem 基础类型的转出口。
 *
 * 为什么要这层：`scripts/` 不是 workspace 包，也不能往根 `package.json` 加依赖
 * （根文件归主导），所以脚本解析不到 `viem`。链上类型经本包转出口后，
 * 脚本只依赖 `@citely/chain` 一处，包边界也更干净。
 */
export type { Address, Hash, Hex } from "viem";
