# Railway 两服务变量配置清单

> 现状（2026-08-01）：主服务已上线并完成 ERC-8004 注册；**验证器拆分做了一半**——
> 第二个服务已建、启动命令已设、非密钥变量已填，但密钥未配到位，主服务处于 Failed。
> 本文件是把拆分做完所需的完整配置。

Railway 项目：`respectful-recreation`
- 服务 A `@citely/server` —— 主服务，启动命令 `pnpm -F @citely/server start`
- 服务 B `citely-deal-desk` —— 验证器，启动命令 `pnpm -F @citely/server start:verifier`

**🔑 = 密钥，用 Railway secret，切勿写进代码或本文件。**

---

## 服务 A：`@citely/server`（主服务，公网）

已有的 29 个非密钥变量保持不变，只需**改 3 个、删 1 个**：

```
VERIFIER_MODE=remote
VERIFIER_URL=http://citely-deal-desk.railway.internal:8080
INTERNAL_SERVICE_TOKEN=<与服务 B 完全相同的随机串>     🔑
```

**删掉**：
```
VERIFIER_PRIVATE_KEY        ← 拆分后主服务不该再持有它，留着等于白拆
```

其余密钥保留在主服务（它需要这些来编排全链路）：
```
OPERATOR_PRIVATE_KEY        🔑   8183 provider + SA 的 EIP-712 签名者
MARKETPLACE_PRIVATE_KEY     🔑   8183 client
PROCUREMENT_PRIVATE_KEY     🔑   x402 采购付款
MODULE_ATTESTER_PRIVATE_KEY 🔑   离线签 Module 认证清单
OPENAI_API_KEY              🔑   判定器
```

已配好的公开值（供核对）：
```
PUBLIC_BASE_URL=https://citely-deal-desk-production.up.railway.app
X402_SELL_MODE=x402-arc-testnet
X402_SELL_PAY_TO=0x45698638CFF60B188E338aa580e11ba9eb560759
X402_SELL_PRICE_USDC=1.00
VERIFIER_ADDRESS=0x07b59ee130519581cd79Bd38B025c9d50eB425E3
ERC8004_IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
ERC8004_AGENT_ID=854638
```

### `MODULE_ID`（采购哪个法域的证据）

合法取值：`us-msb` | `uk-msb` | `eu-msb` | `sg-msb` | `ae-msb`（缺省 `us-msb`）。
写错的值会让主服务**在启动时**就带着合法取值列表报错——不再拖到第一次真实采购、
付款那一刻才炸成 404。

跑 `ae-msb`（阿联酋，2026-08 上线）时：

```
MODULE_ID=ae-msb
MODULE_PRICE_USDC=1.00      ← 上游单价就是 1.00。配错只影响账本 amount_nominal
                               （实付一律按 Gateway 真实扣款记），但对账会难看
```

另有三条前置条件：

1. **procurement 钱包的 Gateway 可用余额 ≥ 2.05 USDC。** 门槛
   `MINIMUM_GATEWAY_BALANCE` 是 1.05，而 ae-msb 单价 1.00：跑完一案余额净减 1.00，
   起始余额低于 2.05 时第二案会以"Gateway 可用余额不足"响亮失败。每多一案 +1.00。
2. **认证清单需已重签。** `packages/verifier/attestations/modules.json` 里若没有
   `ae-msb@2026.08.1`，案件会在验证器检查②以 `attestation_missing` 失败、走 reject
   路径（escrow 退回客户）。这是 fail-closed，不会误放行，但案件跑不完。
3. **判定口径不匹配。** `RUBRIC_PATH` 仍是 `rubrics/us-msb.json`（暂无 UAE rubric，
   且 rubric 与 `MODULE_ID` 之间没有一致性校验），判定器会拿美国口径的 item 去问
   阿联酋交易，结果预期偏向 HOLD/ESCALATE 并路由到人工升级。

---

## 服务 B：`citely-deal-desk`（验证器，仅内网）

**完整清单——Raw Editor 整段替换成这些**：

```
ARC_CHAIN_ID=5042002
ARC_RPC_URL=https://arc-testnet.drpc.org
ARC_RPC_URL_FALLBACK=https://rpc.testnet.arc.network
JOB_CONTRACT_ADDRESS=0x0747EEf0706327138c69792bF28Cd525089e4583
USDC_ADDRESS=0x3600000000000000000000000000000000000000
CHAIN_POLL_INTERVAL_MS=5000
RUBRIC_PATH=rubrics/us-msb.json
VERIFIER_ADDRESS=0x07b59ee130519581cd79Bd38B025c9d50eB425E3
INTERNAL_SERVICE_TOKEN=<与服务 A 完全相同的随机串>     🔑
VERIFIER_PRIVATE_KEY=<验证器私钥>                      🔑
```

**验证器上不该出现的**：
- `VERIFIER_MODE` / `VERIFIER_URL` —— 那是主服务用来找验证器的，验证器不需要知道自己在哪
- 其余四把私钥（OPERATOR / MARKETPLACE / PROCUREMENT / MODULE_ATTESTER）
- `OPENAI_API_KEY` —— 三检是纯确定性检查，判定回路里没有 LLM
- Railway 底部 `Suggested Variables` 里扫源码给的私钥建议，**一个都别填**

---

## 生成共享令牌

```bash
openssl rand -hex 32
```

同一个值填进两个服务的 `INTERNAL_SERVICE_TOKEN`。它是两服务互认的凭据。

---

## 为什么这样拆

agent card 对外声称 *"a separate checker — running on its own, with its own key"*。
把验证器与主服务合在一个进程里，这句话就是假的：同一进程持有全部密钥时，
"独立验证"只是代码结构上的分层，不是安全边界。

拆分后的实质区别：**主服务即使被完全攻破，也签不出一份验证器签名**——
它没有那把钥匙。这也是三检里第①检（EIP-712 验签）价值的来源：
SA 由运营密钥签、由验证器密钥验，两把物理分离，不是自己验自己。

`VERIFIER_URL` 用 Railway 内网地址（`.railway.internal`），验证器不暴露公网——
它只被主服务调用，没有对外开放的必要。

---

## 配完之后的验证

1. 两个服务都 Deploy
2. 主服务 `/health` 返回 ok
3. 跑一次真实案件，确认 SA 的三检通过（`deliverable_signature` / `module_attestation`
   / `rubric_coverage` 全 PASS）——这证明主服务确实调通了内网的验证器
4. 确认主服务变量列表里**没有** `VERIFIER_PRIVATE_KEY`
