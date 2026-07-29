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
