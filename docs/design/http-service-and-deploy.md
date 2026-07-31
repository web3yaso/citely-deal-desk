# Deal Desk HTTP 服务与 Railway 部署（v1）

> 范围严格限定为主会话下达的三件：T1 `packages/server` HTTP 服务、T2 验证器独立部署、
> T3 Railway 部署配置。**不改既有包的对外契约**，不扩范围。
>
> 参考实现：`msb-agent/src/http/`（只读）。结构照抄，不自创。

## 0. 背景

Deal Desk 从"只买"变成"既买又卖"：向 msb-agent 买证据（x402 买方，已有
`@citely/chain` 的 `createX402Client`），向下游卖判定（x402 卖方，本文档）。
对外身份走 ERC-8004，注册用的 URI 指向本服务的 agent card。

## 1. 依赖方向

```
chain ← engine ← verifier
              ↖ server（新，只依赖 engine + chain，不被任何包依赖）
```

`@citely/server` 处在依赖图的叶子，**不许被 engine/chain/verifier 反向 import**。

## 2. 端口注入（关键设计）

server 落地时，engine 的 `runCase()` 与 chain 的 x402 卖方中间件尚未合入。
因此 server **不直接 import 它们**，而是定义端口类型（`src/ports.ts`），由
`src/index.ts` 在进程启动时做适配注入。好处有二：

1. 不被上游阻塞，且上游形状变化只影响 `index.ts` 一处适配层；
2. **T2 的进程拆分全靠这个注入点**——验证那一步是端口，进程内实现与 HTTP 远端实现
   可互换，主服务因此可以不持有 `VERIFIER_PRIVATE_KEY`。

端口清单：

| 端口 | 用途 | 生产实现 |
| --- | --- | --- |
| `CaseRunner` | 跑全链路，产出签名 SA | engine `runCase()` 适配 |
| `CaseReader` | 按 id 读案件状态与 SA | engine `CaseStore` 适配 |
| `PaymentGate` | x402 卖方中间件 | chain `x402-server` 适配 |

## 3. 端点

| 方法 | 路径 | 付费 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 否 | 服务索引：能力、定价、端点清单、免责声明 |
| GET | `/health` | 否 | 体检（`/healthz` 同义别名，兼容 msb-agent 习惯） |
| GET | `/.well-known/agent-card.json` | 否 | ERC-8004 agent card |
| GET | `/.well-known/agent-registration.json` | 否 | 链上身份；未注册时 404，**不作空声明** |
| POST | `/cases` | **是** | 收 DealInput，跑全链路，返回签名 SA |
| GET | `/cases/:id` | 否 | 查案件状态与 SA |

约束：

- `POST /cases` 请求体上限 256KB（`bodyLimit`），超限 413；
- **schema 校验在收费前完成**（照抄 msb-agent 的做法）：无效请求不进支付流程，
  避免"付了钱才发现参数错"；
- 全局限流器（照抄 `rate-limit.ts` 结构），`/health` 跳过。

## 4. agent card 的诚实性要求

card 必须写清：能力、定价、四个可用 module、以及免责声明
「输出为基于公开法源整理的检查项状态，不构成法律意见」。

**绝不写入**：任何私钥、任何内部服务 URL（`VERIFIER_URL`）、任何令牌。
`agent-card.test.ts` 用负向断言守住这条（card 的 JSON 序列化结果里不得出现
密钥形状的字符串与内部变量名）。

## 5. T2：验证器独立服务

Railway 上两个服务：

- `deal-desk-api`（主）：持运营 / 采购 / marketplace 密钥 + `OPENAI_API_KEY`，
  **不持 `VERIFIER_PRIVATE_KEY`**；
- `deal-desk-verifier`：**只持 `VERIFIER_PRIVATE_KEY`**。
  `packages/verifier/src/key-source.ts` 的 `FORBIDDEN_ENV_VARS` 负向测试保持原样有效——
  那 5 个变量在这个服务上根本不注入。

通信选 **HTTP 回调**（同步）：主服务签好 SA 后 `POST {VERIFIER_URL}/verify`，
验证器跑三检 + `settleVerifiedJob`（complete / reject 由**它自己的密钥**发链上交易），
返回 `{passed, reasonHash, outcomes, action, txHash}`。

- 选它不选轮询/队列：三检同步、演示要当场看结果；队列要额外存储与状态机，
  一天内做不完还多一个故障面。
- 鉴权：共享 `INTERNAL_SERVICE_TOKEN`（Bearer），定长比较，仅这一对内部调用使用。
- **不静默降级**：`VERIFIER_URL` 缺失时拒绝启动，不回落到进程内验证——
  否则"验证器独立密钥"这条对外主张就是假的。

## 6. T3：Railway 部署

Railway 自动识别 Node，看 `package.json` 的 `start` 脚本；端口读环境变量 `PORT`。

env 清单**只列变量名，绝不写值**，见 `docs/deploy-railway.md`。

## 7. 落地状态与已知阻塞（2026-07-31）

HTTP 层、agent card、请求校验、收费闸接线、远端验证器客户端与验证器侧应用
**均已完成且有测试覆盖**（`pnpm -F @citely/server test` 141 项）。

**未打通的一处**：`@citely/chain` 的 `createJobClient` 要求 `JobRoleWallets`
三把钱包全部齐全（`client` / `provider` / `evaluator`）。因此

- 主服务为了建 JobClient 被迫持有 `VERIFIER_PRIVATE_KEY`；
- 验证器服务为了发 `complete` / `reject` 被迫持有另外两把。

两个方向都会让"独立进程、独立密钥"变成假的。**所需改动在 chain**：
把三把钱包改成按需可选（调用对应写方法时才要求存在，缺失即响亮抛错）。

在此之前：

- `VERIFIER_MODE=in-process` 可用，但启动时打横幅声明该模式下
  「独立验证器、独立密钥」**不成立**（仅本地联调）；
- `VERIFIER_URL` 远端模式与 `verifier-index.ts` **拒绝启动**并说明原因，
  不用假钱包凑数。

另有一处对原设计的**必要偏离**（已在 `case-request.ts` 写明理由）：
`POST /cases` 的请求体不是裸 `DealInput`，而是 DealInput **加一个 `settlement` 块
与 `expires_at`**。`DealInput` 里没有收款方地址，少了它压根产不出 SA；
`expires_at` 由调用方给定则是为了 `sa_hash` 可复现（服务端取墙上时钟会让
"同样输入 → 同样 SA"当场失效）。

## 实现步骤清单

- [x] 1. `packages/server` 骨架：`package.json`（仅 `hono` + `@hono/node-server` 新依赖）、`tsconfig.json`
- [x] 2. `src/constants.ts`：服务名、免责声明、能力与定价常量 + 测试
- [x] 3. `src/public-url.ts`：解析公网基地址（照抄 msb-agent，付费模式强制 HTTPS）+ 测试
- [x] 4. `src/rate-limit.ts`：限流中间件（照抄 msb-agent 结构）+ 测试
- [x] 5. `src/ports.ts`：`CaseRunner` / `CaseReader` / `PaymentGate` 端口类型
- [x] 6. `src/deal-input.ts`：`parseDealInput` 手写校验（仓库不引入 zod）+ 测试
- [x] 7. `src/agent-card.ts`：`buildAgentCard` / `buildAgentRegistration` + 测试（含不泄密负向断言）
- [x] 8. `src/app.ts`：`createApp(options)` 六个端点 + 测试
- [x] 9. `src/index.ts`：进程入口与端口适配装配
- [x] 10. T2：`src/verify-client.ts` 远端验证器客户端（HTTP + Bearer）+ 测试
- [x] 11. T2：`packages/server/src/verifier-app.ts` 验证器侧 HTTP 应用 + 测试
- [x] 12. T3：`docs/deploy-railway.md`（两个服务的 start 脚本、端口、env 变量名清单）
- [x] 13. 自验：`pnpm -F @citely/server test`、`typecheck`、`lint`，本地起服务打 `/health` 与 agent card
