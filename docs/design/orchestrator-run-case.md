# 编排入口 `runCase`（engine T1）

> 目标：把散在 `demo/run-vertical-slice.ts` 里的全链路编排收成 engine 内的**单一函数**，
> 让 HTTP 服务（edge 的 `packages/server`）与演示脚本共用同一条主线，
> 差别只在**注入的实现**（链上写、验证器调用、判定器 provider）。

## 1. 边界

- 本文档只覆盖 `@citely/engine` 内的改动。`demo/`、`packages/server` 不属于本次范围。
- 依赖方向不变：`chain ← engine ← verifier`。**engine 绝不 import `@citely/verifier`**，
  所以三检与收口以**结构化端口类型**注入（`VerificationReportView` / `SettlementActionView`，
  与 verifier 的 `VerificationReport` / `SettlementAction` 结构兼容，编译期由调用方对齐）。
- 不变量 2 不松动：`condition` 仍只由 `policy/legs.ts` 从 Module 结果推导，
  判定器 verdict 只进 `basis[]` 与 `confidence`。`runCase` 里没有第二条路径。
- `sa_hash` 稳定性：`expires_at` 一律**从链上 Job 回读**，编排里不出现墙上时钟；
  `signed_at` 走 `attestation`（不进哈希）。

## 2. 对外形状

```ts
runCase(request: CaseRequest, deps: RunCaseDeps): Promise<CaseResult>
```

- `CaseRequest`：案件事实（`caseId` / `deal` / `rubric`）+ 商务参数（收款方、金额、
  Job 角色地址、`expiresAt`、模块与报价）+ 可选的出口 4 升级配置。
  **全部由调用方给定，engine 不读环境变量。**
- `RunCaseDeps`：`jobClient`（chain）、`stores`（engine 的 SQLite 仓储）、
  `adjudicator`（llm/cache/mode）、`procure`（x402 采购端口）、
  `operatorAccount`（签 SA 的运营账户）、`verify`、`settle`、可选 `clock` / `logger`。
- `CaseResult`：`jobId` / `sa` / `saHash` / `exit`（五出口）/ 判定明细 / 三检结论 /
  收口动作 / 采购回执 / 账本行 / `replayed`。

## 3. 幂等（HTTP 语境的新要求）

三层，缺一不可：

| 层 | 键 | 落点 | 防的是 |
|---|---|---|---|
| 请求级 | `caseId`（客户端幂等键） | `case_runs` 表 + 进程内 `KeyedMutex` | 重复建 Job、重复跑全流程 |
| 链上写 | `${jobId}:${action}` | 既有 `tx_log`（`SqliteIdempotencyStore`） | 重发交易 |
| 采购 | `(caseId, moduleId)` | 新增 `purchases` 表 | 重复付费（x402 是**链下**付款，不走 tx_log） |
| 入账 | `(ref, ref_type, category, direction, account)` | 既有 `ledger` UNIQUE | 重复入账 |

请求级语义：

- 同 `caseId` + 同请求指纹 → 直接返回**上次的结果快照**，`replayed: true`，不重跑任何一步；
- 同 `caseId` + **不同**请求指纹 → 抛 `CaseRequestConflictError`（HTTP 应答 409），
  绝不用新参数覆盖既有案件；
- 同 `caseId` 正在跑 → 同进程内被 `KeyedMutex` 串行化（后到者最终走"重放"分支）；
  跨进程则抛 `CaseRunInFlightError`（409）。
- `running` 记录超过 `staleRunMs`（默认 15 分钟）视为**遗留自崩溃进程**，允许接管重跑——
  重跑的安全性由下面三层幂等兜底，否则一次崩溃会把这个 `caseId` 永久锁死。

`case_runs` / `purchases` 都是**纯新增表**，按 `db/schema.ts` 的既定规则不需要 bump
`SCHEMA_VERSION`（版本相符时仍会跑一遍 DDL）。

## 4. 并发

`runCase` 会被 HTTP 服务并发调用，逐项确认共享状态：

- **SQLite**：better-sqlite3 是同步 API，单条语句不会交错；跨进程场景补
  `PRAGMA busy_timeout`，避免 `SQLITE_BUSY` 直接抛。
- **golden cache**：`FileGoldenCache.put` 改为**同目录临时文件 + rename**（原子替换），
  `get` 对损坏/半截 JSON 按未命中处理而不是抛错——并发下同一 key 的读写会撞上。
- **案件状态机**：同一 `caseId` 由 `KeyedMutex` 串行；不同 `caseId` 互不影响
  （`cases` 表按 `case_id` 主键）。
- **状态跃迁**：重跑时用 `advanceCaseState` 做单调推进（已到达或已越过则跳过），
  不再对合法重跑抛 `CaseStateError`。

## 5. 长耗时的处理（给主导决策，本次不实现任务化）

一次完整案件 = 真链交易（createJob/setBudget/fund/submit/complete，5 笔）+ LLM 判定
（rubric 每项一次调用）+ x402 采购，几十秒起步，且受链上确认时间支配。

**建议：任务化（202 + `case_id` + 轮询），不要同步返回。** 理由：

1. 反向代理（Railway 默认 ~30s~5min）与浏览器/客户端超时会在链上交易还没确认时切断连接，
   而**连接断了流程不会回滚**——客户端只能重试，重试又落到幂等层，结果是"用户看不到结果、
   系统其实已经跑完"，这是最糟的失败形态；
2. x402 卖方中间件的计费点是"受理请求"，同步长连接会让"付了钱但连接超时"高频出现；
3. `runCase` 已经是**可重入**的：任务化只需要一个 worker 调它 + `GET /cases/:id`
   读 `case_runs` 快照，engine 侧不需要额外改造。

`runCase` 本身同步/异步两种外壳都支持——是否任务化由 edge 决定，engine 不预设。

## 6. 已知取舍（需主导确认）

1. **出口 1 不建 Job**。合约里出口 1 是"验证器在 Funded 态 `reject`"，那是
   client 已注资的语境。服务侧我们**自己就是建 Job 的一方**，材料根本读不了时
   先建 Job 再 reject 等于白花一笔 gas、白占一份 escrow。所以 `runCase` 在
   intake 判失败时**在任何链上写之前**抛 `IntakeRejectedError`（服务应答 4xx），
   路由结论仍完整挂在错误对象上。
2. **reject 收口不写 `refund` 账本行**。退款金额必须来自链上 `Refunded` 事件，
   编排读不到就不记——账本里的假数字比缺行危险。采购行照记（那笔钱确实付了）。
3. **出口 3 不会在主线上出现**。编排在判定**之前**就采购 Module 结果
   （`condition` 的推导需要它），所以判定后仍未消解的数据缺口按 `routing/exits.ts`
   的既定语义归入出口 4，而不是再买一轮。多轮采购是后续扩展。
4. **`briefingPack` 只产出不落盘**。卷宗正文随 `CaseResult` 返回，落盘/投递由
   调用方决定（服务与演示的存放位置不同）。

## 实现步骤清单

- [x] S1 `db/schema.ts`：新增 `case_runs`、`purchases` 两张表；补 `busy_timeout` pragma
- [x] S2 `orchestrator/keyed-mutex.ts` + 单测：按 key 串行化的进程内互斥
- [x] S3 `orchestrator/run-store.ts` + 单测：`CaseRunStore`（请求级幂等：开始/重放/冲突/接管）
- [x] S4 `orchestrator/purchase-store.ts` + 单测：`SqlitePurchaseStore` + `procureOnce` 幂等采购
- [x] S5 `orchestrator/stages.ts` + 单测：intake 状态、legs 组装、SA 组装、账本拆分、状态单调推进
- [x] S6 `orchestrator/types.ts`：请求 / 依赖端口 / 结果类型（含结构化的三检与收口端口）
- [x] S7 `orchestrator/run-case.ts` + 单测：主编排（含五出口路由与出口 4 升级材料）
- [x] S8 `orchestrator/index.ts` + `package.json` 导出 `./orchestrator`
- [x] S9 `adjudicator/cache.ts`：原子写 + 容错读（并发安全）+ 单测
- [x] S10 自验：`pnpm -F @citely/engine test`、`typecheck`、`pnpm lint`、`idempotency-check.ts`
