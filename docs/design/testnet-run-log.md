# Arc Testnet 真链运行记录

> 从 README 移出留档（README 面向使用者，本文件面向开发与评审）。

全部为 Arc Testnet 真实交易，可在 `testnet.arcscan.app` 复核。

**spike①：8183 五函数裸调**（Job 159784）

| 调用 | 角色 | txHash | 状态 |
|---|---|---|---|
| `createJob` | client | `0xe10a8fc99e24193b72703b580659e507ea0f868111db708518011f3b88193c09` | open |
| `setBudget` | provider | `0xa6b180a0e4e188905450bf904143c67f81b584b06563584f9278b931c39ddd8d` | open |
| `fund` | client | `0x3c83334dbc85bfe9b26a277d6fa7ae06c4b31961c97e03a9aa746928fb6eba06` | funded |
| `submit` | provider | `0x9e0de61a754d41bea4928a8f5f4fe4d42ba1fecb1aac4436c2210af93c0d32a6` | submitted |
| `complete` | evaluator | `0x3c1f505ab9fe03619cc33e6c12affac00d1ec19bcc9ca2b9a13c63e731353c36` | completed |

`setBudget` 由 **provider** 发起——参考实现里 client 调用会 `revert Unauthorized()`，
这是规范正文与实现的差异之一，真链验证了实现侧行为。

**端到端纵切**（Job 159786）

- 8183 Job → funded；`complete` tx
  `0xc9b624350d331e8e4ea19bafd0666337b53ae126cc4746a864b4c03f91569009` → completed
- x402 真实付费调用 msb-agent：采购钱包 Gateway 余额 `1.500000 → 0.700000 USDC`，
  差额 0.80 恰为 `us-msb` 定价
- Module 真实返回 **`overall=HOLD`**（非录制快照），据此 `condition=HOLD`，
  客户钱包按自有预设策略判定 `execute=false`——**系统在真实合规结论下扣住了付款**
- 案件费拆分：`budget=3000000 platformFee=0 evalFee=0 net=3000000`，
  费率读自链上 view（该部署当前费率确为 0）
- 账本 `nominal/actual` 与链上金额当场对账一致

这一跑的价值不在于"跑通了"，而在于它是**在 HOLD 结论下停住的**：
判定回路没有 LLM 参与，扣款决定由确定性代码从 Module 结果推导，
客户钱包独立复核后自行决定不付。

## 五出口真链验证（2026-07-30）

代码写了不等于链上验证过。逐出口在 Arc Testnet 实跑，记录状态迁移与资金去向。

### 出口 1：受理失败（Funded 态 reject）— ✅ Job 159987

| 步骤 | txHash | 状态 |
|---|---|---|
| `createJob` | `0x14600f95c3e2892406a42d5b0d829b2741f97d91764d6e22a9e31a94d1bd3602` | open |
| `setBudget` | `0x24852a13a7249162bfc04a9224683aff5f5f6e5fc9b3f2ab0b10811fd4954d6f` | open |
| `fund` | `0xf615d3cd78525ed295d3d528021cb24dca7acc3e3f882ff4fb4c896c81682ef2` | funded |
| `reject`（evaluator） | `0x3e781ec8c29a58430f8f06e08cf9029c3d9c935a6f9cc63401ed5348cf04c3c4` | **rejected** |

预算全额退回 client。**注意 Arc 上 gas 也用 USDC 付**——client 余额差额是
`退款 − gas`，不是净增退款额，对账时别把 gas 误判为退款失败。

### 出口 5：超时退款（claimRefund）— ✅ Job 159988

`createJob` 时 `expiredAt = now + 360s`，到期后 `claimRefund`：
`0x9aef1fcef9a7aa7c8a1fa5c4845b3db2818e75658b30d4cb43ecde780479363c` → **expired**

**三个只有真跑才知道的事实**：

1. **过期时间下限是 5 分钟**：参考实现 `if (expiredAt <= block.timestamp + 5 minutes)
   revert ExpiryTooShort();`。演示要展示超时路径，Job 必须建成短过期
   （我们用 360 秒，留 60 秒余量避开下限）——原 spike 脚本用的 86400 秒（24 小时）
   在演示现场根本等不到。
2. **出口状态是 `Expired` 而不是 `Rejected`**，且 `claimRefund` **不扣任何手续费**
   （与 `reject` 的退款路径在链上是两条不同的路，账本 category 也不同）。
3. **退款后链上 `budget` 字段仍保留原值、不清零**。对账时看到"钱退了但 budget 还挂着"
   是正常的，不是 bug。

### 出口 2：高置信主线 — ✅ Job 159786（见上文端到端记录）

### 出口 3：付费采购消解 — ⏳ 待验证

需两次 `/check`（首次缺 signal → 付费采购 → 数据合并重跑），us-msb 每次 0.80 USDC。

### 出口 4：解释性 gray（ESCALATE + Review Job）— ⏳ 待验证

引擎侧已完成（Review Job 模板 + 会谈卷宗）；marketplace 侧待补。
真链验证需由 **Marketplace 钱包**注资 Review Job（`createJob` 无 `client` 参数，
`client` 即 `msg.sender`——所以谁发交易就是谁当 client，专家的钱必须来自委托人）。
