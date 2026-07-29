# Citely Deal Desk

一笔跨境付款要不要放行？Deal Desk 读你的交易结构，逐个参与方判定合规状态，
产出一份 **Settlement Authorization（SA）**——你的钱包可以独立核验它，然后自己决定付不付。

SA 是**条件证明**，不是付款指令。放款与否始终由你的钱包按自有策略决定。

> 输出为基于公开法源整理的检查项状态，不构成法律意见。

## 能拿到什么

给它一笔交易，它返回逐腿的放款条件：

```json
{
  "case_id": "case-001",
  "bound_to": { "job_id": "159786", "expires_at": "2026-08-05T00:00:00Z" },
  "modules_used": [{ "module_id": "us-msb", "version": "2026.07.1", "evidence_hash": "…" }],
  "legs": [{
    "party": "uk_service_agent",
    "payee": "0x…",
    "amount_nominal": "2500.00",
    "condition": "HOLD",
    "basis": [{ "item_id": "MT-03", "verdict": "gray_data", "source": "31 CFR § 1010.100(ff)" }],
    "confidence": "gray_data_resolved"
  }],
  "attestation": { "sa_hash": "0x…", "signer": "0x…", "signature": "0x…" }
}
```

每条腿的 `condition` 只有三种：`PASS`（可放款）、`HOLD`（暂缓）、`ESCALATE`（需人工复核）。
`basis` 给出依据的判定项与法源引用，`attestation` 是可验签的 EIP-712 签名。

SA 绑定 job_id、收款方、金额、Module 版本、证据哈希与有效期——是**受限执行凭证**，
不是一份开放式报告。

## 快速开始

```bash
pnpm install
cp .env.example .env          # 填钱包密钥与 API key，各字段说明见文件内注释
node --import tsx scripts/doctor.ts        # 环境体检，逐项 ✅/❌，不打印任何密钥
```

体检全绿后，采购钱包需要预存一笔 USDC 到 Circle Gateway（x402 付费调用花的是这里的余额）：

```bash
node --import tsx scripts/gateway-deposit.ts 1.50
```

> **到账是分钟级的，别等到要用时才存。**
> 钱包里的 USDC 余额和 Gateway 可用余额是两个数——只有后者能用于付款，`doctor` 会分开显示。

跑一个案件：

```bash
node --import tsx demo/run-vertical-slice.ts --dry-run   # 不发交易、不付费
node --import tsx demo/run-vertical-slice.ts             # 真实 Arc Testnet
```

> 公共 RPC `rpc.testnet.arc.network` 会限流。代码会自动降级到备用节点，
> 但演示时建议直接设 `ARC_RPC_URL=https://arc-testnet.drpc.org`。

## 它做了什么

```
你的交易 → 拆成逐参与方的判定项
         → 按需向合规 Module 付费取证（x402，按次计费）
         → 确定性规则引擎汇总成 SA
         → 独立验证器三检后在链上放行案件款
         → 你的钱包读 SA，按自己的策略决定放款
```

四层里只有中间一层是 Citely 的软件：

| 层 | 谁的 |
|---|---|
| 合规 Module 服务 | 第三方，按次付费调用 |
| **判定引擎 / 验证器** | **Citely** |
| ERC-8183 托管、x402 支付、USDC 转账 | Arc 标准件 |
| 执行钱包 | **你的** |

## 两条设计承诺

**放款条件不由 LLM 决定。** `PASS/HOLD/ESCALATE` 完全由确定性规则从 Module 返回的
检查结果推导。语言模型只做编排与摘要，改不动任何一条判定——这不是靠自觉，
是规则引擎的函数签名在类型层面就拿不到模型输出。

**Citely 不碰你的钱。** 案件款托管在 ERC-8183 合约里，我们只收案件服务费、
只支出 Module 采购费。你的结算资金全程在你自己的钱包和合约里，
付款目标恒为 SA 里的收款方。

## 配置

`.env.example` 里有全部字段与说明。要点：

| 用途 | 说明 |
|---|---|
| 五把链上密钥 | 客户 / 运营 / 验证器 / 采购 / Module 认证，**互不共享** |
| `OPENAI_API_KEY` | 判定器用；该进程不持有任何链上私钥 |
| `JOB_CONTRACT_ADDRESS` | Arc Testnet 上的 ERC-8183 部署 |
| `ADJUDICATOR_MODE` | `cache_first` / `cache_only` / `live`；离线演示用 `cache_only` |

判定结果按输入哈希缓存，命中即字节级复现——**可复现性由缓存提供，不由模型提供**。

## 更多

- 架构与设计文档：`docs/design/`
- 合规 Module 服务（独立仓库）：[msb-agent](https://github.com/web3yaso/msb-agent)

## 免责

仅用于 Arc Testnet 演示，无真实资金。合规判定来自公开法源整理的 Demo Module，
不构成法律意见。
