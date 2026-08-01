<div align="center">

# Citely Deal Desk

**把一笔跨境付款的合规问题，变成一份 Settlement Authorization
—— 由你自己的钱包在放款前独立核验的条件证明。**

[English](README.md) · [合规 Module 服务](https://github.com/web3yaso/msb-agent)

</div>

---

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

## 合规 Module 服务

Deal Desk 自己不含法律知识库，它**按次向一个独立部署的服务付费购买证据**——
[`msb-agent`](https://github.com/web3yaso/msb-agent)，独立仓库、独立部署、独立钱包、独立定价。

这个分离是刻意的：它让整件事成为**双边流转**而不是一个单体应用。

| | |
|---|---|
| **它是谁** | 独立的合规 Module 供应商，运行在 Railway，已注册 **ERC-8004**（Agent ID `851930`，链上可查） |
| **卖什么** | 四个法域的确定性检查——`us-msb` · `uk-msb` · `eu-msb` · `sg-msb` |
| **怎么收费** | **x402 按次付费**，经 Circle Gateway 以 USDC 结算——0.80 / 0.40 / 0.60 / 0.20 |
| **我们怎么调** | HTTP `POST /modules/:id/check` → `402` → 签名 → 重放 → `200`。无 SDK 耦合、无共享数据库 |
| **返回什么** | `checks[]`、`overall`、`settlement_constraints`、`evidence_hash`、`maintainer_wallet`、`royalty_bps` |

`settlement_constraints` 是两个系统之间的机器接口——它是确定性 Policy Engine 推导
`PASS` / `HOLD` / `ESCALATE` 的**唯一**输入，判定器 LLM 碰不到它。

`evidence_hash` 可以对着该服务公开的规则离线重放，第三方无需信任任何一方即可复算证据。

### 耦合点在哪

依赖面刻意做薄，而且全部可见：

| 位置 | 依赖什么 |
|---|---|
| `packages/chain/src/types/module.ts` | 请求/响应形状，逐字段对齐该服务的 schema——**只有类型，无跨仓库 import** |
| `packages/chain/src/validate/module-response.ts` | 手写 type guard 校验线上响应（不共享校验库） |
| `packages/chain/src/x402-client.ts` | 基址与付费调用流程 |
| `.env` → `MSB_AGENT_BASE_URL` | 端点地址。指向别处，Deal Desk 就向另一个供应商采购 |

换供应商只需改一个环境变量并满足同样的响应形状——两个仓库之间没有构建期链接。

### 它是真的收到钱的

不是 mock。出口 3 那次真链运行的记录（见
[`docs/design/testnet-run-log.md`](docs/design/testnet-run-log.md)）：

```
结算 ID 566e5a78-59ea-462e-aba1-6cf12be0762a   0.80 USDC
Gateway 余额 2.70 → 1.90   （余额差与客户端自报实付一致）
账本：module_fee  ref_type=gateway_receipt  结算tx=待结算
版税义务：0.04 USDC → 0x76B05e...47B9（500 bps，取自真实响应）
```

版税由真实付费响应里的 `royalty_bps` 算出——fixture 层有一道闸
**拒绝用合成数据渲染版税行**，所以这个数字没法被伪造进演示。

## 作为 agent 调用它

Deal Desk 是一个上线并注册在链上的 agent，不是一个你 vendor 进项目的库。

### 找到它：ERC-8004 身份

| | |
|---|---|
| **Agent ID** | `854638` |
| **注册表** | `0x8004A818BFB912233c491871b3d84c89A494BD9e`（Arc Testnet） |
| **注册 tx** | [`0x6385f21b…`](https://testnet.arcscan.app/tx/0x6385f21b8e1470dc23e25d49d92414c9c432d5d7e34c7ff49a5b631e7f2fd888) |
| **agent card** | [`/.well-known/agent-card.json`](https://citelyserver-production.up.railway.app/.well-known/agent-card.json) |

注册表上 `tokenURI(854638)` 解析到 agent card——能力、定价、端点**链上可发现，不用问我们**。
上游的合规 Module 服务用同样方式注册（Agent ID `851930`），
所以"谁向谁买了证据"这条链路是公开可追溯的。

### 付费调用：x402

`POST /cases` 按次计费。**无需 API key、无需开户**——你的钱包按请求付费。

首次请求返回 `402`，报价单在 `payment-required` 响应头里（base64）。
签名后重放请求即得 `200` 与 Settlement Authorization。
`@circle-fin/x402-batching` 的 `GatewayClient.pay()` 一行完成整个握手：

```ts
const gw = new GatewayClient({ chain: "arcTestnet", privateKey });
const { data } = await gw.pay(`${BASE}/cases`, { method: "POST", body: deal });
```

> **必须先给 Circle Gateway 预存余额**——x402 花的是它，不是钱包里的 USDC，
> 且到账是分钟级。注意报价单里 `verifyingContract` 是 **Gateway Wallet 合约**
> 而不是 USDC 合约，对着 USDC 签名是这里最常见的失败方式。

### 结算：ERC-8183

SA 绑定到[参考实现](https://eips.ethereum.org/EIPS/eip-8183)
`0x0747EEf0706327138c69792bF28Cd525089e4583` 上的一个 Job。三个角色、三把独立密钥：

| 角色 | 谁 | 调用 |
|---|---|---|
| `client` | 你 | `createJob`、`approve`+`fund`、`claimRefund` |
| `provider` | Citely | `setBudget`、`submit` |
| `evaluator` | Citely 的验证器 | `complete`、`reject` |

**你的资金在 8183 escrow 里，从不经过我们的地址。** `submit` 只把 SA 的哈希锚定上链，
文档本身留在链下。

**三处部署合约的实际行为与规范正文不同**——都是真跑出来的，记在
[`testnet-run-log.md`](docs/design/testnet-run-log.md)：

- `setBudget` **只有 provider 能调**（`msg.sender != job.provider` 即 revert）
- `JobStatus` 是**六态**——`claimRefund` 到达 `Expired` 而非 `Rejected`，且不扣费
- `expiredAt` 有 **5 分钟下限**；要演示超时路径必须建短过期 Job，否则等一天

### 升级会开第二个 Job

某条腿返回 `ESCALATE` 时，SA 会附带一份 Review Job 模板——一个独立的 8183 Job，
**你是 client 并由你注资**，独立专家是 `provider`，我们的验证器裁定。
**专家的酬金由提出复核的一方支付，永远不来自我们。** 链上已验证：Job `162523`。

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
