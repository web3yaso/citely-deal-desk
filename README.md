# Citely Deal Desk

把一笔跨境交易的合规判定，变成一份**可被钱包独立核验的条件证明**——
判定过程可复算，资金路径可审计，而 Citely 全程不碰客户的钱。

> 输出为基于公开法源整理的检查项状态，不构成法律意见。

## 它解决什么

跨境付款前要回答"这笔能不能付、付给谁要附什么条件"。今天这件事靠人读法规、写邮件、
来回确认，结论既不可复算也不可审计。

Deal Desk 把它拆成四层，每层的产物都能被下一层机器核验：

| 层 | 是什么 | 产物 |
|---|---|---|
| L1 | 合规 Module 服务（外部，已上线） | 检查项状态 + `evidence_hash` |
| L2 | 案件引擎 / Policy Engine / 判定器 / 验证器 | 结算授权书（SA） |
| L3 | Arc Testnet 标准件 | 8183 Job、x402 付费、USDC 转账 |
| L4 | 客户执行层 | 钱包按**自有预设策略**核验 SA 后决定是否付款 |

SA 是**条件证明**，由钱包按自有预设策略核验执行——不是 Citely 授权付款。

## 五条架构不变量

这五条不是口号，每条都有代码或测试兜底，改动违反任一条即打回。

**1. 零自定义合约。** 链上只用 ERC-8183 参考实现与 Circle 标准件。
仓库里没有一行 Solidity。

**2. 判定回路里没有 LLM。** `PASS/HOLD/ESCALATE` 只从 Module 返回的
`settlement_constraints` 推导。保证方式不是"我们记得别用"——
`packages/engine/src/policy/condition.ts` 的函数签名在**类型层面收不到** LLM 的 `verdict`。
注入回归 A7 更进一步：喂给系统一个被完全策反的模型输出，断言 SA 每条腿的 `condition`
逐字节不变。测的不是模型抗不抗注入，是不变量本身是否物理成立。

**3. 客户资金零接触。** 托管在 8183 合约，不是我方地址。
`complete` 后 escrow→provider 的那笔是我方案件费，属对价收入。

**4. 链上只有哈希、签名、状态、资金。** 案件材料、SA 正文、报告全文一律不上链。

**5. 材料是数据不是指令。** rubric 进 system prompt，材料只能作为 user 消息里的
单个 JSON 对象传入。`renderSystemPrompt(item: RubricItem)` 的签名里没有材料类型——
想把材料塞进指令通道，编译就过不去。

## 仓库结构

```
packages/chain/        8183 客户端、x402 采购、钱包、轮询、链上探测
packages/engine/       判定器、Policy Engine、SA 生成与签名、状态机、账本、沙箱解析器
packages/verifier/     验证器三检 + 收口（独立进程、独立密钥）
packages/marketplace/  L4 客户侧演示 agent
demo/                  合成案件、端到端脚本
rubrics/               判定项定义
scripts/               体检、Gateway 存款、spike
docs/design/           技术方案、集成合约、判定器 provider 设计、审查清单
```

依赖方向单向：`chain ← engine ← verifier`。

## 跑起来

```bash
pnpm install
cp .env.example .env        # 填六类密钥 + 三个地址，说明见文件内注释
node --import tsx scripts/doctor.ts          # 环境体检，逐项 ✅/❌，不打印任何密钥
node --import tsx scripts/gateway-deposit.ts 1.50   # 采购钱包存款，到账需几分钟
node --import tsx demo/run-vertical-slice.ts --dry-run   # 端到端，不发交易不付费
```

去掉 `--dry-run` 即为真链运行。

> **RPC 提示**：公共 `rpc.testnet.arc.network` 会限流（实测返回 `request limit reached`）。
> 代码已实现自动降级到 `ARC_RPC_URL_FALLBACK`，但演示时建议直接把
> `ARC_RPC_URL` 设为 `https://arc-testnet.drpc.org`。

## 关键实测事实

这些是踩出来的，不是查文档得到的：

- **ERC-8183 参考实现与规范正文有三处不符**，以实现为准：`fund` 没有 `expectedBudget`
  形参（抢跑保护未落地，我方在调用层缓解）；`setBudget` **仅 provider** 可调；
  `JobStatus` 是**六态**，多一个 `Expired`。
- **Arc Testnet 已有可用部署**，无需自行部署：
  `0x0747EEf0706327138c69792bF28Cd525089e4583`（ERC1967 代理），
  `paymentToken()` = `0x3600000000000000000000000000000000000000`。
- **该部署当前费率为 0**（`platformFeeBP` / `evaluatorFeeBP` 皆为 0），
  故 provider 实收等于 budget。费率一律读链上 view，**不硬编码**——
  演示输出显示的就是链上真值。
- **x402 付款花的是 Circle Gateway 余额，不是钱包 USDC 余额**，
  且 deposit 到账是分钟级。演示前必须预存。

## 验证

```bash
pnpm test        # 587 个测试
pnpm typecheck
pnpm lint
```

注入回归 A1–A8 在 `packages/engine/src/adjudicator/injection.test.ts`，
零网络、零 API key，用 Fake provider 驱动。干净版与注入版材料同源
（`demo/fixtures/`，由同一个 `baseDeal()` 构造，只差埋入的那一句），
否则"两版判定相同"这条断言不成立。

## 设计文档

- `docs/design/CitelyDealDesk技术实现方案-v2.2.md` — 唯一事实源
- `docs/design/contracts-vertical-slice.md` — 集成合约（含实测校正）
- `docs/design/llm-provider-openai.md` — 判定器 provider 选型与确定性策略
- `docs/design/review-checklist-vertical-slice.md` — 合并审查双清单

判定结果的可复现性由 **golden cache** 提供，不是由模型提供——
`temperature=0` 是尽力项，缓存命中才是字节级复现的承诺。

## 许可与免责

仅用于 Arc Testnet 演示，无真实资金。合规判定结论来自公开法源整理的 Demo Module，
不构成法律意见。

## 真链运行记录（Arc Testnet，2026-07-29）

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
