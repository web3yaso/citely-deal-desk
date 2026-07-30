# 彩排记录（2026-07-30）

三次冷启动彩排的原始日志与结论。命令：

```bash
pnpm -F @citely/engine db:reset            # 冷启动：清空两个库
ARC_RPC_URL=https://arc-testnet.drpc.org \
  node --import tsx demo/run-vertical-slice.ts --dry-run   # ×3，中间不再 reset
```

`run1.log` / `run2.log` / `run3.log` 是三次的完整输出，`run-cache-only.log` 是
`ADJUDICATOR_MODE=cache_only` 的离线复现尝试。

## 幂等验证结论：通过

| 指标 | run1 | run2 | run3 |
|---|---|---|---|
| `sa_hash` | `0xd5892d01…` | **同左** | **同左** |
| `reasonHash` | `0x85ee427f…` | **同左** | **同左** |
| 账本落盘 | 新增 4 / 挡下 0 | 新增 0 / **挡下 4** | 新增 0 / **挡下 4** |
| 库内该案件行数 | 4 | 4 | 4 |
| x402 采购 | 首次付费 | **复用，不重复付款** | **复用，不重复付款** |

`sa_hash` 三次逐字相同，说明 SA 里没有掺进任何随当前时刻变化的内容
（有效期取自链上 `JobView.expiredAt`，不是 `Date.now()`）。

账本 4 行覆盖了 `ref_type` 三态里的两态（第三态 `txHash` 走退款路径，本次未触发）：

```
case_fee   operator    in   3.000000  ref_type=jobId
case_fee   verifier    in   0.000000  ref_type=jobId
module_fee procurement out  0.800000  ref_type=gateway_receipt
royalty    procurement out  0.040000  ref_type=gateway_receipt
```

版税 0.040000 = 采购价 0.800000 × 500bps，收款方是**真实录制**里的
`maintainer_wallet`，不是编造值。

## ⚠️ 未通过：`cache_only` 离线复现会中止

```
✗ 纵切演示中止：GoldenCacheMissError: golden cache miss in cache_only mode
```

原因：5 个判定项里有 2 个（MT-04 / MT-05）每次都因
`LlmSchemaError: response incomplete: max_output_tokens` 降级为 `unverifiable`，
而**兜底结果按设计不写 golden cache**，所以它们永远进不了缓存。
`cache_first` 下这不影响结果（兜底是确定性的，`sa_hash` 仍稳定），
但 `cache_only` 会响亮失败。

这条是**现场韧性的第一道保险**（v2.3 §9：链慢就切离线复现），需要 engine 调大
`max_output_tokens` 后重录一次 golden，让 5/5 都进缓存。**不是我方可以绕过的问题**——
绕过就意味着让兜底结果冒充真判定进缓存。

降级预案：现场直接放**备份录屏**，不依赖 `cache_only`。
