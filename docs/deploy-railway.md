# Railway 部署（两个服务）

> **本文件只列变量名，绝不写值。** 值填在 Railway 的 Variables 面板里，
> 任何密钥都不进仓库、不进日志、不进 agent card。

## 服务拓扑

| 服务 | 角色 | 启动命令 | 持有的密钥 |
|---|---|---|---|
| `deal-desk-api` | 主服务：卖判定、买证据、签 SA | `pnpm -F @citely/server start` | 运营 / 客户 / 采购三把 + `OPENAI_API_KEY` |
| `deal-desk-verifier` | 验证器：三检 + 链上收口 | `pnpm -F @citely/server start:verifier` | **只有 `VERIFIER_PRIVATE_KEY`** |

Railway 自动识别 Node，看 `package.json` 的 `start` 脚本；端口从环境变量 `PORT` 读，
两个服务都已按此实现（未设置时主服务默认 3000、验证器默认 3001）。

> ⚠️ **当前状态**：`deal-desk-verifier` 与主服务的远端模式**尚未打通**，
> 原因见本文末「已知阻塞」。在阻塞解除前，两个服务都会**拒绝启动**而不是
> 降级成"假装拆开了"。本地联调请用 `VERIFIER_MODE=in-process`（见下）。

## 端点

| 方法 | 路径 | 付费 |
|---|---|---|
| GET | `/` | 否 |
| GET | `/health`（`/healthz` 同义） | 否 |
| GET | `/.well-known/agent-card.json` | 否 |
| GET | `/.well-known/agent-registration.json` | 否 |
| POST | `/cases` | **x402 按次** |
| GET | `/cases/:id` | 否 |

ERC-8004 注册用的 URI 指向 `https://<主服务域名>/.well-known/agent-card.json`。

## `deal-desk-api` 的环境变量名

**链上密钥（三把，互不共享；此服务不含验证器密钥）**

- `OPERATOR_PRIVATE_KEY`
- `MARKETPLACE_PRIVATE_KEY`
- `PROCUREMENT_PRIVATE_KEY`

**链上地址与网络**

- `VERIFIER_ADDRESS` —— 验证器钱包地址（公开信息，不是密钥；`createJob` 的 evaluator）
- `JOB_CONTRACT_ADDRESS`
- `USDC_ADDRESS`
- `ARC_CHAIN_ID`
- `ARC_RPC_URL`
- `ARC_RPC_URL_FALLBACK`

**卖方收费（x402，本服务收钱）**

- `X402_SELL_MODE` —— `x402-arc-testnet` 或 `off`
- `X402_SELL_PRICE_USDC`
- `X402_SELL_PAY_TO`
- `X402_FACILITATOR_URL`
- `PUBLIC_BASE_URL` —— Railway 给的公网域名；**收费模式下必须是 HTTPS**

**买方采购（向 msb-agent 付费取证）**

- `MSB_AGENT_BASE_URL`

**判定器**

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `ADJUDICATOR_MODE`
- `LLM_PROVIDER`

**案件参数**

- `CASE_BUDGET_USDC` —— 案件费（escrow 预算）
- `MODULE_ID`
- `MODULE_PRICE_USDC`
- `RUBRIC_PATH`

**验证器接线**

- `VERIFIER_URL` —— 验证器服务的内部地址（**绝不进 agent card**）
- `INTERNAL_SERVICE_TOKEN` —— 两个服务之间的共享令牌
- `VERIFIER_MODE` —— 仅在**不配** `VERIFIER_URL` 时需要，且只能填 `in-process`

**ERC-8004 身份（注册完成后再填）**

- `ERC8004_AGENT_ID`
- `ERC8004_IDENTITY_REGISTRY`

**持久化**

- `DB_PATH` —— 相对路径按**仓库根**解析（engine `db/path.ts` 是全仓唯一入口）

> **务必挂 Railway Volume**。案件状态、账本、采购表与幂等表都在 SQLite 里，
> 容器文件系统重启即丢——丢的不只是历史，还有"重跑不重复付款"的幂等记录。
> 建议挂到 `/data` 并把 `DB_PATH` 指过去（绝对路径）。

**rubric**

- `RUBRIC_PATH` —— 判定用的 rubric 文件；相对路径按仓库根解析，启动时校验存在性

> 路径类变量一律锚仓库根、不看 cwd：`pnpm -F @citely/server start` 的 cwd 是包目录，
> 用 cwd 解析会让同一个配置值在不同入口指向不同文件（`DB_PATH` 当初就这么分裂过）。

## `deal-desk-verifier` 的环境变量名

**只有这一把密钥：**

- `VERIFIER_PRIVATE_KEY`

其余全是公开信息：

- `INTERNAL_SERVICE_TOKEN`
- `JOB_CONTRACT_ADDRESS`
- `USDC_ADDRESS`
- `ARC_CHAIN_ID`
- `ARC_RPC_URL`
- `PORT`（Railway 注入）

**这个服务上绝不能出现**：`OPERATOR_PRIVATE_KEY`、`MARKETPLACE_PRIVATE_KEY`、
`PROCUREMENT_PRIVATE_KEY`、`MODULE_ATTESTER_PRIVATE_KEY`、`OPENAI_API_KEY`。
这条纪律由 `packages/verifier/src/key-source.ts` 的 `FORBIDDEN_ENV_VARS` 负向测试守着；
主服务方向的镜像断言在 `packages/server/src/config.test.ts`
（「主服务绝不读取 `VERIFIER_PRIVATE_KEY`」，用记录型 Proxy 实证）。

## 两个服务之间怎么通信

主服务签好 SA 后，向验证器发一次：

```
POST {VERIFIER_URL}/verify-and-settle
Authorization: Bearer {INTERNAL_SERVICE_TOKEN}
{ "sa": …, "rubric": …, "submittedDeliverableHash": "0x…", "chainId": 5042002 }
→ { "verification": { passed, reasonHash, outcomes }, "settlement": { action, txHash } }
```

**三检与收口刻意合并成一次调用**：若拆成 `/verify` 与 `/settle` 两个端点，
`/settle` 就必须接受调用方递过来的三检报告——主服务大可以编一份 `passed: true`
让验证器照签，独立验证器的全部价值当场归零。合并之后，结论由验证器自己产出，
收口用的 `jobId` 也取自 **SA 里签过名的** `bound_to.job_id`，不接受请求参数指定。

令牌比较走 sha256 + `timingSafeEqual` 定长比较，不因长度差异泄露信息。

## 部署后自检

```bash
curl https://<主服务域名>/health
curl https://<主服务域名>/.well-known/agent-card.json
curl https://<验证器域名>/health          # 期望 {"status":"ok","role":"verifier"}
```

## 已知阻塞（远端验证器）

`@citely/chain` 的 `createJobClient` 要求 `JobRoleWallets` 三把钱包**全部齐全**
（`client` / `provider` / `evaluator`）。于是：

- 主服务为了建 JobClient 被迫持有 `VERIFIER_PRIVATE_KEY` → "独立密钥"变成假的；
- 验证器服务为了发 `complete` / `reject` 被迫持有另外两把 → 同样是假的。

**需要 chain 把这三把钱包改成按需可选**（调用对应写方法时才要求存在，缺失即响亮抛错）。
改完之后：

- 主服务只给 `client` + `provider`；
- 验证器服务只给 `evaluator`；
- `packages/server/src/verifier-index.ts` 接上已完成的 `verifier-app.ts` 即可。

在此之前两个入口都**拒绝启动**，不用假钱包凑数。
