# 演示 UI 改造：以 ERC-8183 任务生命周期为叙事主线

> 任务名：`demo-ui-8183-narrative`
> 状态：已确认（2026-08-02 拍板：方案 B / job-case 双词、路由不变 / verification hero /
> 单 implementer 串行 / 不修请求方校验已知限制。合约摘录见
> `contracts-demo-ui-8183-narrative.md`）
> 目标读者：执行方（implementer / teammate）、QA、安全审计
> 上游事实源：`docs/design/CitelyDealDesk技术实现方案-v2.2.md` §2.1–2.2、
> `docs/design/contracts-vertical-slice.md` §2（8183 函数/状态/授权矩阵，**照录不发明**）、
> `docs/demo-ui.md`（现状）

---

## 1. 背景与目标

### 1.1 用户诉求原话

> 「演示UI有个优化点，应该突出使用erc8183，用户是提交任务，在得到完成的verification」

解读：当前 UI 的主线是**我们的六步握手机制**（谁签哪一步、为什么必须交替签名），
这是"实现视角"。用户要的是**委托方视角**：

- 起点 = 「我向链上提交了一个任务（Job）」；
- 终点 = 「我拿到了这个任务**已完成的 verification**」；
- ERC-8183 必须在界面上**显性可见**（合约地址、jobId、状态、事件、链上哈希），
  而不是埋在第 2/3/5 步的小字里。

### 1.2 现状盘点（读码结论）

三视图 + 六步握手，静态三件套共约 680 行（`index.html` 33 / `app.js` 492 / `style.css` 158）。

**`#/new`（建单页）现状**：一张表单卡 + 一张「Handshake」卡（6 个 `<li>`，每行
`who / label / state`）。8183 只以文字出现在两处 step label 里；jobId 出现在 step detail
的纯文本中；**没有任何 arcscan 链接**。

**`#/case/<id>`（案件页）现状**卡片顺序：

1. Case 概要（state/exit、8183 job、SA hash、valid until、settlement tx —— 唯一一个 arcscan 链接）
2. 采购（msb-agent / x402）
3. 模型判定（Model verdicts）
4. SA 逐腿条件
5. 独立验证三检 ← **用户要的"完成的 verification"排在倒数第二**
6. 钱包决策 banner（收尾）

即：**交付物（verification）在页面最底部，8183 只有一行 jobId 文本。** 这正是用户说的问题。

### 1.3 现有数据可得性（决定方案边界）

| 叙事需要的事实 | 现在拿得到吗 | 来源 |
|---|---|---|
| jobId | ✅ | `snapshot.jobId` / 流程中 `state.jobId` |
| 8183 合约地址、chainId、arcscan base | ✅ | `GET /app/api/config`（`job_contract`/`chain_id`/`arcscan_base`） |
| provider / evaluator 地址 | ✅ | 同上（`provider`/`evaluator`） |
| escrow 预算金额 | ✅ | 同上（`case_budget_atomic`） |
| `JobCreated` topic0 | ✅ | 同上（`job_created_topic`，已从 ABI 派生） |
| 交付物哈希（= 链上 `submit` 的 `deliverable`） | ✅ | `snapshot.saHash`（= `deliverableHash`） |
| 三检结论 | ✅ | `snapshot.verification.outcomes[]`（`deliverable_signature` / `module_attestation` / `rubric_coverage`） |
| **链上 `complete` 的 `reason` 参数** | ✅ | `snapshot.verification.reasonHash` ← **当前 UI 完全没显示，是最强的 8183 证据** |
| `complete`/`reject` 的 tx | ✅ | `snapshot.settlement.{action,txHash}` |
| **`submit` 的 tx** | ❌ | 只在 `tx_log`（键 `${jobId}:submit`），未出给任何端点 |
| **`setBudget` 的 tx** | ❌（案件页） | 只在 `tx_log`；建单页当次流程内存里有 |
| **链上 Job 当前 status（open/funded/submitted/completed/rejected/expired）** | ❌ | 只有 `jobClient.getJob()`，服务端没有只读端点 |
| `createJob` / `fund` 的 tx | ❌（服务端永远不知道） | 浏览器钱包自己发的，只在当次页面内存里 |

结论：**"四拍时间线 + verification 头部化"用现有数据就能做到 85%；缺的是链上
当前状态与 `submit`/`setBudget` 两笔 tx**——这正是方案 A 与 B 的分界线。

### 1.4 目标（可验收）

1. 打开 `#/case/<id>` 的**第一屏**就是：这个 8183 Job 处于什么状态 + 它的 verification 结论；
2. 两个视图共用**同一条 8183 生命周期时间线**（Job Created → Funded → Work Submitted → Verified），
   四拍名称与链上事件一一对应；
3. jobId / 8183 合约地址 / 每一拍对应的 tx 都可点进 arcscan；
4. 六步握手的**谁签哪一步**事实一字不改（`setBudget` 仍显示为 provider-only 且注明是链上强制），
   只改呈现层级（降为四拍下面的明细行）；
5. 不新增任何合约调用语义、不动 SA 措辞、不动免责声明、不破坏"业务内容不上链"表述。

### 1.5 非目标

- 不做真实链上事件流回放（见方案 C 与其否决理由）；
- 不做 8183 Job 的新写操作（不新增 `reject` / `claimRefund` 按钮——那是新合约调用语义面，超范围）；
- 不改 agent card（演示设施不进能力面，现有纪律不变）；
- 不修复「服务端不校验请求方是否为 Job 的链上 client」这一已知限制（需请求签名，仍属超范围，
  文档口径保持不变）。

---

## 2. 技术选型

### 2.1 备选方案

#### 方案 A — 纯前端叙事重构（不动后端）

只改 `webapp/{index.html,app.js,style.css}`。时间线的四拍状态由**快照推导**：

- 有 `snapshot.jobId` → Created 已完成；
- 案件跑到有 SA（`snapshot.sa`）→ Funded 必然已完成（engine 对外部 Job 强制校验过 `funded`）；
- 有 `snapshot.saHash` → Work Submitted 已完成（`saHash` 就是链上 `submit` 的 `deliverable`）；
- 有 `snapshot.settlement` → 终局拍按 `action` 渲染 `completed` / `rejected`；无则「submitted, 未收口」。

链接层：只链得到 `settlement.txHash`（+ 合约地址、jobId）。建单页当次流程可额外把浏览器自己发的
`createJob` / `fund` tx 链出来（内存里有）。

#### 方案 B — 方案 A + 一个只读端点 `GET /app/api/jobs/:id`（**推荐**）

在 A 的全部前端工作之上，加一个演示专用只读端点，返回**链上真实 Job 视图** +
**服务端已知的三笔 tx**（`setBudget` / `submit` / `complete|reject`，从 `tx_log` 读）。
案件页与建单页据此把时间线做成"从链上读回来的"，而不是"我们自己记得的"。
链读失败时**自动降级为方案 A 的渲染**（页面照常出，标注 chain read unavailable）。

#### 方案 C — 事件流方案：服务端 `getLogs` 拉全量 8183 事件 + 新增 `#/job/<jobId>` 独立视图

按 jobId 的 indexed topic 拉 `JobCreated`/`BudgetSet`/`JobFunded`/`JobSubmitted`/
`JobCompleted`/`PaymentReleased`/`EvaluatorFeePaid`/`Refunded` 全部日志，逐条带
blockNumber + txHash 展示，并让任何 jobId（哪怕没有对应案件）都能单独看。

### 2.2 对比表

| 维度 | A 纯前端 | **B 前端 + 只读端点** | C 事件流 + 独立 Job 视图 |
|---|---|---|---|
| 改动面 | webapp 3 文件 | webapp 3 + `demo-api.ts` + `app.ts` + `index.ts` 接线 | B 的全部 + chain 包新增 `getJobEvents` + 新路由/新视图 |
| 预估新增/改动行数 | ~260 | ~380 | ~700+ |
| 8183 显性度 | 中高（四拍 + jobId + 合约 + 1 个 tx 链接） | **高**（四拍状态**来自链上** + 4–5 个 tx 链接 + 角色地址 + escrow 余额语义） | 最高（逐事件、逐区块） |
| `submit` 那一笔（8183 的核心动作）可见 | ❌ 看不到 tx | ✅ | ✅ |
| 旧案件重开（换浏览器/换机器）时时间线完整 | 部分（推导，无 tx 链接） | ✅ | ✅ |
| 对公共 RPC 的压力 | 无 | 每次案件页 1 次 `getJob`（TTL 缓存 10s） | 每次多区间 `getLogs`——**踩已记录的 Arc 公共 RPC 限流坑** |
| 新失败模式 | 无 | 1 个（链读失败 → 已设计降级路径） | 多个（区间/分页/限流/重组，且没有 fromBlock 记录，全量扫描不可行） |
| 测试成本 | 静态文本断言 + 手测 | + 4–6 条端点单测（已有 `demo-flow.test.ts` 模式可套） | + chain 包事件解析单测 + 端点单测 + 视图 |
| 不变量风险 | 无 | 无（纯读，无新写语义） | 无（纯读），但工期风险高 |
| 新增第三方依赖 | **无** | **无** | **无**（viem 已在） |
| 许可证 / 维护活跃度 | 不适用（零新依赖） | 不适用（零新依赖） | 不适用（零新依赖） |

> 三个方案**都不引入任何新的运行时依赖**，所以"许可证 / 维护活跃度"在主选型里不适用。
> 唯一涉及第三方依赖选型的是**前端测试手段**，见 §7.2 单独对比（含许可证与活跃度）。

### 2.3 推荐：方案 B

理由，按权重排序：

1. **用户诉求的落点恰好在 A 的缺口上。** 「用户提交任务、拿到完成的 verification」
   这句话里，"提交任务"对应的链上动作是 `submit(jobId, deliverable)`——而当前 UI
   **连这笔交易存在都看不出来**，A 也补不上（服务端有 tx 但没端点）。B 是补上这一笔的最小代价。
2. **"从链上读回来"和"我们自己记得"在评审席上不是一回事。** 案件页现在展示的一切都来自我们
   自己的 SQLite 快照。加一次 `getJob` 之后，页面能说"这个 Job 现在链上是 `completed`
   状态、escrow 3.00 USDC、client 是你的地址"——这是**独立可核**的，与"三纪律（SQLite 是
   唯一真相源，链上只对账）"完全一致：我们仍不用链上状态驱动业务，只用它**对账展示**。
3. **增量极小且形态已有先例。** `DemoApi` 已有 `setBudget` 这个要读链的方法（先 `getJob`
   再写），新方法只是砍掉写的那一半；路由层的 id 形状闸 `JOB_ID_PATH_PATTERN` 现成；
   `tx_log` 的 `lookup(idempotencyKey(...))` 现成。
4. **C 的增量价值远低于其风险。** 逐事件展示比"四拍 + 每拍一个 tx 链接"多出来的信息，
   对观众几乎是零；而 `getLogs` 正撞在仓库已记录的 Arc 公共 RPC 限流坑上（`docs/demo-ui.md`
   三个坑之一就是 RPC 限流），演示当场挂掉的概率不可接受。**否决 C。**
5. **A 不是被丢掉，而是被内建成 B 的降级路径。** B 的前端必须在 `GET /app/api/jobs/:id`
   失败/超时的情况下渲染出 A 的完整效果——这条要求写进实现清单与测试，等于 A 是 B 的
   保底子集，工期风险为零。

---

## 3. 叙事设计（先定义"讲什么"，再定义"怎么写"）

### 3.1 四拍时间线与链上事实的映射（**照录 `contracts-vertical-slice.md` §2，不发明**）

| 拍 | UI 文案 | 链上事件（ABI 已定义） | 事件后的 `JobState` | 谁签 | 备注行（UI 小字） |
|---|---|---|---|---|---|
| 1 | **Job created** | `JobCreated(jobId, client, provider, evaluator, expiredAt, hook)` | `open` | **你的钱包**（client） | 内含 `BudgetSet(jobId, amount)` —— 由 Citely（provider）发起，**链上只允许 provider 调** |
| 2 | **Escrow funded** | `JobFunded(jobId, client, amount)` | `funded` | **你的钱包**（client） | 先 `approve` USDC 给 Job 合约，再 `fund`；钱进的是 8183 合约，不是 Citely 地址 |
| 3 | **Work submitted** | `JobSubmitted(jobId, provider, deliverable)` | `submitted` | Citely（provider） | `deliverable` = `sa_hash`（SA 规范化字节的 sha256）；**SA 正文链下** |
| 4 | **Verified & completed** | `JobCompleted(jobId, evaluator, reason)` | `completed` | 验证器（evaluator，独立密钥） | `reason` = 三检报告的 `reasonHash`；同笔交易触发 `PaymentReleased` / `EvaluatorFeePaid` |

**终局拍的三个替代形态（必须如实渲染，禁止一律显示 Verified）**：

| 形态 | 事件 | `JobState` | UI 文案 |
|---|---|---|---|
| 拒绝 | `JobRejected(jobId, rejector, reason)` | `rejected` | **Rejected — escrow refunded to your wallet** |
| 超时退款 | `JobExpired(jobId)` + `Refunded(jobId, client, amount)` | `expired` | **Expired — refund claimable / claimed by the client** |
| 已提交未收口 | —（停在拍 3） | `submitted` | **Awaiting evaluator** |

> 纪律：**时间线不猜**。链读拿不到状态时，用快照能证明的拍显示 done，其余显示 unknown（灰），
> 并显式标注 "on-chain state unavailable"——不允许用"应该已经完成了"去填。

### 3.2 用户视角的一句话（页面主叙事）

- `#/new` 顶部：**"Submit a job to Citely — your wallet is the ERC-8183 client."**
  副文案：*Your wallet opens the job and funds the escrow. Citely can submit work against it,
  but only the evaluator key can release or refund your money.*（沿用现有 `#/new` 已有措辞的同义改写，
  语义一字不变）
- `#/case/<id>` 顶部（新 hero）：**"Verification — job #<jobId>"**，紧跟三检 3/3 + `reasonHash` +
  complete tx 链接。

### 3.3 措辞红线（审计按此逐条查）

允许改的：卡片顺序、标题措辞、"case"/"job"两个词的使用位置、step 的分组呈现。

**禁止改 / 禁止出现**：

1. footer 免责声明原句不动：
   `Results are compliance check statuses compiled from public legal sources. Not legal advice.`
2. SA 口径不动：SA 是**条件证明，由钱包按自有预设策略核验执行**。
   页面**不得**出现 `authorize` / `authorizes the payment` / "Citely approves" 之类表述；
   现有 banner 原句 `The SA is proof, not an instruction` 保留。
3. **不得**把 verification 写成 "compliant" / "legal" / "approved" / "cleared"。
   verification 的语义严格限定为：**三项确定性检查通过，且验证器据此在链上 `complete` 了这个 Job**。
   hero 里必须有一句限定语（建议：*Three deterministic checks on the deliverable —
   not a legal conclusion.*）。
4. **不得**出现"材料/报告上链"含义的表述。链上只有 `sa_hash` 与 `reasonHash`，
   涉及它们的文案必须写明 "hash only, the document stays off-chain"。
5. `setBudget` 的呈现必须保留"链上限定 provider"这一事实（现有 `#/new` 文案
   `the one step the chain restricts to the provider` 语义保留）。
6. "谁签哪一步"不得因为分组而含糊：每个明细行仍要显示 `your wallet` / `citely` / `agent` 标签。

---

## 4. 模块划分与接口定义

### 4.1 后端（packages/server）

#### 4.1.1 `demo-api.ts` 新增只读能力

```ts
/** 链上 Job 的对外只读视图（全部公开信息；金额/时间一律十进制字符串，JSON 安全）。 */
export interface JobStatusView {
  readonly job_id: string;                 // 十进制字符串
  readonly status: JobState;               // "open"|"funded"|"submitted"|"completed"|"rejected"|"expired"
  readonly client: Address;
  readonly provider: Address;
  readonly evaluator: Address;
  readonly budget_atomic: string;          // 6 位小数原子单位
  readonly expired_at: string;             // Unix 秒，十进制字符串
  /** 服务端**自己发过**的那几笔交易（从 tx_log 读；没发过就没有该键）。 */
  readonly tx: {
    readonly set_budget?: Hex;
    readonly submit?: Hex;
    readonly complete?: Hex;
    readonly reject?: Hex;
  };
}

export interface DemoApi {
  readonly publicConfig: () => Record<string, unknown>;
  readonly encode: (action: unknown, params: unknown) => EncodedTx;
  readonly setBudget: (jobId: bigint) => Promise<{ readonly txHash: Hex }>;
  /** 新增：只读。Job 不存在（client 归零）抛 DemoApiError(404)。 */
  readonly jobStatus: (jobId: bigint) => Promise<JobStatusView>;
}

export function createDemoApi(deps: {
  readonly jobClient: JobClient;
  /** 新增：读 setBudget/submit/complete/reject 的 txHash。只用 lookup，不写。 */
  readonly txLog: IdempotencyStore;
  readonly config: DemoApiConfig;
  /** 新增（可选）：缓存用的时钟，测试注入假时钟。默认 `Date.now`。 */
  readonly nowMs?: () => number;
}): DemoApi;
```

约束：

- `tx` 的键**必须**用 chain 导出的 `idempotencyKey(jobId, action)` 构造，
  server 不自己拼 `${jobId}:submit`（沿用 `tx-log.ts` 里已写明的纪律）；
- `jobStatus` 内置 **TTL 缓存**：`const JOB_STATUS_TTL_MS = 10_000;`
  仅缓存成功结果，`Map` 上限 200 条、超限按插入序淘汰最旧。理由：公共 RPC 限流是本仓库
  已记录的实战坑，一个无鉴权的 GET 不能变成 RPC 放大器；
- 缓存**不缓存 tx_log 部分**？——不。整个 `JobStatusView` 一起缓存即可（10s 内的
  tx_log 变化对演示无影响），保持实现单一。

#### 4.1.2 `app.ts` 新增路由（挂在 `registerDemoRoutes` 内，**不进 agent card**）

```
GET /app/api/jobs/:id
  200 → JobStatusView
  400 → { error: "invalid_job_id", message }          // 复用 JOB_ID_PATH_PATTERN
  404 → { error: "job_not_found", message }           // DemoApiError(404)
  502 → { error: "chain_unavailable", message }       // 链读抛错（非 DemoApiError）
```

- 502 的 message **必须**是固定安全串（如 `"Chain read failed; try again."`），
  **不得**回显 RPC 原始错误（可能含 URL / key 片段）；原始错误经 logger 落服务端日志即可。
- 该路由与既有 `POST /app/api/jobs/:id/set-budget` 路径不冲突（方法与子路径都不同）。
- 全局限流中间件（`app.use("*", createRateLimiter(...))`）自动覆盖本路由，无需额外配置。

#### 4.1.3 `index.ts` 接线

`SqliteIdempotencyStore` 目前在 `buildJobClient()` 内部 `new` 出来。改为在 `main()` 里
建一次，同时传给 `buildJobClient` 与 `createDemoApi`——**同一个实例**，不建第二个。
（不是性能问题，是"两份状态两个真相"的问题。）

### 4.2 前端（packages/server/src/webapp）

全部仍是无构建步骤的 vanilla JS。新增/改动函数签名：

```js
/** 四拍常量：文案 + 链上事件 + 对应 JobState。照录 §3.1，改这里等于改叙事，需回设计。 */
const JOB_BEATS = [
  { id: "created",   label: "Job created",          event: "JobCreated",   state: "open" },
  { id: "funded",    label: "Escrow funded",        event: "JobFunded",    state: "funded" },
  { id: "submitted", label: "Work submitted",       event: "JobSubmitted", state: "submitted" },
  { id: "verified",  label: "Verified & completed", event: "JobCompleted", state: "completed" },
];

/** 十六进制形状闸：不合形状一律返回 null（既防错链接，也是 XSS 的第一道闸）。 */
function asTxHash(value)   // /^0x[0-9a-fA-F]{64}$/ → string | null
function asAddress(value)  // /^0x[0-9a-fA-F]{40}$/ → string | null

/** arcscan 链接。hash/addr 非法或 cfg 缺失时返回 null，调用方据此不渲染 <a>。 */
function arcscanTxUrl(cfg, hash)
function arcscanAddressUrl(cfg, address)

/**
 * 生成时间线模型。**只从证据推导，缺证据就是 unknown，不猜。**
 * @param {object} p
 * @param {JobStatusView|null} p.chainStatus  GET /app/api/jobs/:id 的结果；失败传 null
 * @param {object|null} p.snapshot            案件快照（案件页有，建单页为 null）
 * @param {object} p.localTxs                 本浏览器本次流程记住的 tx（可为空对象）
 * @param {string|null} p.terminalKind        "completed"|"rejected"|"expired"|null
 * @returns {{beats: Array<{id,label,event,status:"done"|"active"|"pending"|"unknown"|"failed",
 *            txHash: string|null, note: string|null}>, chainKnown: boolean}}
 */
function buildTimelineModel(p)

/** 渲染时间线 HTML。**每个动态插值必须过 esc()**（沿用文件头的 XSS 纪律）。 */
function timelineHtml(model, cfg)

/** 案件页头部主交付物：verification hero。 */
function verificationHeroHtml(snap, cfg)

/** 拉链上状态；任何失败返回 null（不抛），调用方降级。带 8s 超时（AbortController）。 */
async function fetchJobStatus(jobId)  // → JobStatusView | null

/** 本浏览器的 tx 记忆：只存本次流程自己发出的 hash，供刚跑完就跳转的案件页用。 */
function rememberLocalTxs(dealId, txs)  // sessionStorage，键 `citely:txs:<dealId>`
function readLocalTxs(dealId)           // 读回时**逐个过 asTxHash**，非法值丢弃
```

#### 视图重排：`#/new`

```
[卡1] Submit a job to Citely           ← 标题改，表单不动（字段、默认值、id 全不变）
[卡2] ERC-8183 job lifecycle           ← 新：四拍时间线（本次流程实时驱动）
        └ 每拍下挂原六步的明细行（who / label / state / tx 链接）
           拍1: connect(you) · createJob(you) · setBudget(citely, chain-restricted)
           拍2: approve(you) · fund(you)
           拍3+4: case run(agent) —— 运行中把 hint 挂在拍3
[卡3] 8183 contract chip: <job_contract> ↗arcscan · chainId 5042002 · escrow 3.00 USDC
```

- `state.steps` 与 `runFlow()` 的**控制流一行不改**（含 retry 的 `status==="done"` 跳过逻辑）；
  只在 `setStep` 后多算一次时间线模型并重渲染；
- step 的 `detail` 里现在是 `tx 0x1234…abcd` 纯文本 → 改成 `<a>` 链接（经 `asTxHash` +
  `arcscanTxUrl` + `esc`）；
- 跑完跳转前调用 `rememberLocalTxs(dealId, {createJob, setBudget, approve, fund})`。

#### 视图重排：`#/case/<id>`

```
[hero]  Verification — job #<jobId>                       ← 新，页面第一屏
          3/3 checks passed · verifier key <evaluator↗>
          reason hash 0x…  ← 这串就是链上 complete(jobId, reason) 的第二个参数
          complete tx ↗arcscan · deliverable (sa_hash) 0x… ← 链上 submit 的 deliverable
          小字：Three deterministic checks on the deliverable — not a legal conclusion.
                Hashes only; the SA document itself stays off-chain.
[卡A]  ERC-8183 job lifecycle（四拍时间线；chainStatus 有则标 "read from chain"，
        无则标 "on-chain state unavailable — shown from the case record"）
        contract <job_contract↗> · client <你的地址↗> · provider · evaluator · escrow 金额
[卡B]  Settlement Authorization — per-leg conditions（原样）
[banner] 钱包决策 banner（原句原样，紧跟 SA 卡）
[卡C]  Independent verification（三检明细表，原样，hero 的展开）
[卡D]  Agent bought evidence from another agent（原样）
[卡E]  Model verdicts（原样）
[卡F]  Case record（原 Case 概要卡剩余字段：state/exit、valid until、settlement tx）
```

- **verification 失败（`verification.passed === false`）时 hero 必须变红并直说**：
  `Verification failed — the evaluator rejected the job on-chain; escrow refunded to the client.`
  不允许显示"Verified"；
- `snapshot === null`（未跑完）时：只渲染 hero 的占位 + 时间线（拍状态按链上读或 unknown），
  保留现有 "No snapshot yet" 语义；
- 所有新增插值继续遵守文件头的 XSS 纪律（`${` 后必须是 `esc(`、`...Html(` 或字面量）。

#### `index.html`

- `<nav>` 增加/改名：`Service` · `Submit a job`（`href="#/new"` 不变，路由不变，旧链接不失效）；
- header 增加一个空容器 `<span id="chain-chip" class="chip"></span>`，由 `app.js` 在
  `loadConfig()` 后填「ERC-8183 · Arc Testnet · 0x…↗」；
- footer 免责声明**一字不动**。

#### `style.css`

新增：`.timeline`（竖向连接线）、`.beat`（`.done/.active/.pending/.unknown/.failed` 五态配色，
复用既有 `--pass/--hold/--escalate/--muted` 变量）、`.hero`（大号 hero 卡）、`.chip`、
`.beat .substeps`（收纳原六步明细行）。不引入任何新色值语义（不新增 CSS 变量）。

---

## 5. 数据结构 / schema 变更

| 项 | 是否变更 | 说明 |
|---|---|---|
| 8183 合约 / ABI | **不变** | 零自定义合约；本次只读 `getJob`，无新写调用 |
| SA schema（`SaBody` / `SaAttestation`） | **不变** | `sa_hash` / `reasonHash` 都是既有字段的展示 |
| `deliverableHash` / `sa_hash` 定义 | **不变** | 定义不可改 |
| SQLite schema（`cases`/`case_runs`/`tx_log`/`ledger`/`purchases`） | **不变** | 只读 `tx_log`，无 DDL |
| `CaseRunSnapshot` | **不变** | 前端只是换个顺序展示既有字段 |
| `GET /cases/:id` 响应 | **不变** | 不动对外 API |
| agent card | **不变** | 演示设施不进能力面 |
| `GET /app/api/config` 响应 | **不变** | 现有字段够用 |
| **新增** `GET /app/api/jobs/:id` | 新增（demo-only） | 只读、公开数据、不进 agent card |
| 模块版本号 / rubric 版本 | **不需要 bump** | 未触及规则文件、判定语义、SA 语义、evidence_hash 任何一环 |

> 明确记录：**本任务不涉及任何版本号 bump**。上游 msb-agent 的模块 `version`
> 与本仓库 rubric 版本均无关联改动；若执行过程中发现需要改动 SA/快照字段，
> **立即停手回设计**，不得顺手改。

---

## 6. 安全考量

### 6.1 输入校验

1. **路径参数**：`GET /app/api/jobs/:id` 复用既有 `JOB_ID_PATH_PATTERN = /^\d{1,78}$/`，
   不匹配直接 400，**不进 BigInt、不进 RPC**（防止超长数字串导致的解析开销）。
2. **前端渲染**：新增的 hash / 地址一律先过 `asTxHash` / `asAddress` 形状闸再进 `esc()` 再进
   模板；形状不合法就不渲染链接（`href` 注入面归零）。案件页渲染的是**调用方可控内容**
   （`deal_id` 任何人可造），这条纪律不能松。
3. **`sessionStorage` 回读是不可信输入**：`readLocalTxs` 读回的每个值必须过 `asTxHash`，
   非法值丢弃——用户可以自己改 sessionStorage，读回即渲染就是自伤型 XSS。
4. **`fetchJobStatus` 的响应也是不可信输入**：`status` 只接受六态白名单之一，
   其余当 unknown；地址/hash 过形状闸。

### 6.2 支付路径（本次**不触碰**，需在审查中确认未被改动）

- x402 闸门逻辑（带 `job_id` 放行）不动；
- `POST /cases` 请求体构造不动（`runFlow` 的 body 组装一字不改）；
- `/app/api/encode` 的三个 action、金额与角色服务端填死的性质不动；
- `setBudget` 端点的四道校验（存在 / provider 是我们 / 状态 open / id 形状）不动；
- **不新增任何会导致签名或转账的前端路径**。新端点是 GET、只读、无副作用。

### 6.3 密钥处理

- 新端点返回的全部字段都是**已经公开**的信息：`provider`/`evaluator` 已在
  `/app/api/config` 里；`client`/`budget`/`status`/`expiredAt` 是链上可读；tx hash 是链上可读。
  **不得**新增任何来自 env 的字段。
- 沿用 `demo-flow.test.ts` 已有的"配置端点不含私钥形状字符串"断言思路，
  给新端点也加一条：响应文本里除 tx hash / 地址外不得出现 64 位 hex（tx hash 本身是
  64 位 hex，所以断言方式是**白名单剔除后再检**，与既有 `job_created_topic` 的写法同款）。
- 502 分支**不回显**底层 RPC 错误（RPC URL 可能带 API key）。这一条要有单测。

### 6.4 新增的滥用面评估

| 面 | 评估 |
|---|---|
| 无鉴权 GET 打 RPC | 全局限流中间件已覆盖 + 10s TTL 缓存 + 只读单次 `getJob`；最坏是替人查一次链 |
| 枚举 jobId 探测 | Job 数据本来就是链上公开的，浏览器直连 RPC 也能读到，**无新增信息泄露** |
| 缓存投毒 | 键是 jobId（已过形状闸），值来自我们自己的 `jobClient`，无外部可控写入 |
| sessionStorage | 同源、本机、只存 tx hash，回读过形状闸；不存任何案件正文 |

### 6.5 不变量自查（审查逐条打勾）

- [ ] 零自定义合约：无新合约、无新写调用、无 ABI 改动
- [ ] 客户资金永不进我方地址：文案与流程均未改动资金路径
- [ ] 链上只有哈希/签名/状态/资金：新展示的 `sa_hash`/`reasonHash` 均标注 "hash only, document off-chain"
- [ ] SA 措辞：无 authorize/approve 语义；`proof, not an instruction` 保留
- [ ] 免责声明：footer 原句在，且 hero 附加了"非法律结论"限定语
- [ ] `setBudget` provider-only 的事实在 UI 上仍然明示
- [ ] LLM 无权改判定这一表述（Model verdicts 卡的小字）未被删除

---

## 7. 实现步骤清单（供执行方逐条打勾，每条可独立验证）

> 包边界标注：`server` = `packages/server/src/*.ts`；`webapp` = `packages/server/src/webapp/*`；
> `docs` = 仓库文档。**本任务不动 `chain` / `engine` / `verifier` / `marketplace` 任何文件**——
> 若发现必须动，停手回设计。

### 阶段一：后端只读端点（server）

- [x] 1. `server` `packages/server/src/demo-api.ts`：新增并导出 `JobStatusView` 接口
      （字段与 §4.1.1 逐字一致）。验证：`npx tsc --noEmit` 或 `pnpm typecheck` 通过。
- [x] 2. `server` `demo-api.ts`：`createDemoApi` 的 `deps` 增加 `txLog: IdempotencyStore` 与
      可选 `nowMs`；`DemoApi` 增加 `jobStatus`。实现：`getJob` → `client === zeroAddress`
      抛 `DemoApiError(404, ...)`；否则用 `idempotencyKey(jobId, action)` 依次 `lookup`
      `setBudget`/`submit`/`complete`/`reject`，命中才放进 `tx`。
      验证：单测（步骤 5）。
- [x] 3. `server` `demo-api.ts`：给 `jobStatus` 加 `JOB_STATUS_TTL_MS = 10_000` 的内存 TTL 缓存
      （只缓存成功结果，Map 上限 200，超限淘汰最旧插入项）。验证：单测断言 TTL 内只调一次
      `getJob`、超时后再调一次（注入假 `nowMs`）。
- [x] 4. `server` `packages/server/src/app.ts`：在 `registerDemoRoutes` 内注册
      `app.get("/app/api/jobs/:id")`，按 §4.1.2 的四种状态码映射；502 分支回固定安全串，
      原始错误只进 logger。验证：单测（步骤 5）。
- [x] 5. `server` `packages/server/src/demo-flow.test.ts`：新增用例
      （a）合法 jobId → 200 且字段齐全、`status` 为六态之一；
      （b）`client` 归零 → 404；
      （c）id 形状非法（`not-a-number` / 79 位数字）→ 400 且 **`getJob` 未被调用**；
      （d）`jobClient.getJob` 抛错 → 502 且**响应体不含**注入错误里的哨兵串（如
      `https://secret-rpc.example/KEY123`）；
      （e）`tx` 字段来自注入的 txLog 替身，键用 `idempotencyKey` 构造；
      （f）TTL 内重复请求只触发一次链读。
      验证：`pnpm --filter @citely/server test` 全绿。
- [x] 6. `server` `packages/server/src/index.ts`：把 `SqliteIdempotencyStore` 提到 `main()` 里
      建一次，分别传给 `buildJobClient` 与 `createDemoApi`（同一实例）。
      验证：`pnpm typecheck` 通过 + 本地 `PORT=8899 … pnpm --filter @citely/server start`
      能起来且 `curl localhost:8899/app/api/jobs/<某个已知 jobId>` 返回 200/404。

### 阶段二：前端骨架与共用组件（webapp）

- [x] 7. `webapp` `app.js`：新增 `asTxHash` / `asAddress` / `arcscanTxUrl` / `arcscanAddressUrl`
      四个纯函数（签名见 §4.2）。验证：手动在浏览器 console 调用，非法输入返回 `null`。
- [x] 8. `webapp` `app.js`：新增 `JOB_BEATS` 常量（四拍，文案/事件/state 与 §3.1 逐字一致）
      与 `buildTimelineModel(p)`；**证据不足一律 `unknown`，禁止推测**。
      验证：console 里用三组假输入（chainStatus=null+有快照 / chainStatus=completed /
      chainStatus=rejected）调用，返回的 `beats[].status` 与 §3.1 表格一致。
- [x] 9. `webapp` `app.js`：新增 `timelineHtml(model, cfg)`；所有插值过 `esc()`，
      非法 hash 不渲染 `<a>`。验证：把 `deal_id`/note 传入 `"><img src=x onerror=alert(1)>`，
      渲染结果里该串以文本形式出现且无弹窗。
- [x] 10. `webapp` `style.css`：新增 `.timeline` / `.beat`（五态）/ `.beat .substeps` /
      `.hero` / `.chip`，仅复用既有 CSS 变量，不新增变量。
      验证：浏览器里四拍纵向连线、五态配色可辨。
- [x] 11. `webapp` `index.html`：nav 第二项文案改为 `Submit a job`（href 不变）；
      header 增加 `<span id="chain-chip" class="chip"></span>`；**footer 免责声明一字不动**。
      验证：`git diff` 显示 footer 段落零改动。
- [x] 12. `webapp` `app.js`：`loadConfig()` 后填充 `#chain-chip`
      （`ERC-8183 · Arc Testnet · <job_contract 短址>`，链到 arcscan 地址页）。
      验证：三个视图任一打开，header 右侧出现可点的 chip。

### 阶段三：`#/new` 改为任务生命周期主线（webapp）

- [x] 13. `webapp` `app.js` `renderNew()`：卡片标题改为
      `Submit a job to Citely — your wallet is the ERC-8183 client`，副文案按 §3.2；
      **表单字段 id / 默认值 / `readForm()` 一律不改**。
      验证：`git diff` 中 `readForm` 函数体零改动。
- [x] 14. `webapp` `app.js`：把 Handshake 卡改造为「四拍时间线 + 每拍下挂原六步明细行」
      （分组见 §4.2）；`STEPS` 数组增加 `beat` 归属字段，`state.steps` 的
      id/who/label/status 语义与 `runFlow` 控制流**一行不改**。
      验证：`pnpm --filter @citely/server test` 仍绿 + 本地 `X402_SELL_MODE=off` 跑一次
      `#/new`，六个明细行仍按原顺序变绿，`setBudget` 行仍标注 provider-only。
- [x] 15. `webapp` `app.js`：step detail 里的 tx 文本改为 arcscan 链接（过形状闸 + esc）；
      `createJob` 拿到 jobId 后在拍 1 上显示 `job #<id>` 并链到合约地址页。
      验证：本地跑一次流程，每笔 tx 都能点开 arcscan 对应交易。
- [x] 16. `webapp` `app.js`：新增 `rememberLocalTxs` / `readLocalTxs`（sessionStorage，
      回读逐个过 `asTxHash`）；`runFlow` 成功跳转前写入。
      验证：跑完流程后 devtools 里能看到 `citely:txs:<dealId>` 键，值全是合法 hash；
      手动把值改成 `<script>` 后刷新案件页，无异常、无弹窗、该 tx 不渲染。

### 阶段四：`#/case/<id>` 交付物头部化（webapp）

- [x] 17. `webapp` `app.js`：新增 `fetchJobStatus(jobId)`（8s `AbortController` 超时，
      任何失败返回 `null` 不抛）。验证：把端点改名模拟 404，案件页照常渲染。
- [x] 18. `webapp` `app.js` `renderCase()`：新增 `verificationHeroHtml(snap, cfg)` 并置于
      页面首位，内容按 §4.2（三检计数、`reasonHash` + "这就是链上 complete 的 reason 参数"、
      complete tx 链接、`sa_hash` = 链上 submit 的 deliverable、evaluator 地址、
      两句限定语）。**`verification.passed === false` 走红色失败文案**。
      验证：用现有案件 `#/case/rehearsal-msb1uis5` 打开，第一屏即为该 hero。
- [x] 19. `webapp` `app.js` `renderCase()`：在 hero 之后插入时间线卡（数据源 =
      `fetchJobStatus` + 快照 + `readLocalTxs`），并标注数据来源
      （`read from chain` / `on-chain state unavailable — shown from the case record`）。
      验证：断网/停服模拟链读失败，卡片仍渲染且标注降级来源（**方案 A 的保底路径**）。
- [x] 20. `webapp` `app.js` `renderCase()`：按 §4.2 重排剩余卡片（SA 腿 → 钱包 banner →
      三检明细 → 采购 → 模型判定 → Case record），**每张卡的内部 HTML 与文案不改**。
      验证：`git diff` 显示这些卡片是整块移动，内部零字符差异（审查时逐块比对）。
- [x] 21. `webapp` `app.js`：`snapshot === null` 分支保持现有语义，且时间线仍渲染。
      验证：构造一个只有 case 行、无快照的案件（或临时改替身）打开页面不报错。

### 阶段五：文案红线与文档

- [x] 22. `server` 新增 `packages/server/src/webapp-copy.test.ts`：读取
      `webapp/{index.html,app.js}` 文本，断言
      （a）footer 免责声明原句存在；
      （b）四拍标签与四个事件名（`JobCreated`/`JobFunded`/`JobSubmitted`/`JobCompleted`）均出现；
      （c）**禁语不出现**：`authorizes the payment`、`Citely authorizes`、`legally compliant`、
      `is compliant`、`legal opinion`（大小写不敏感）；
      （d）`proof, not an instruction` 与 `provider` 受限说明仍在。
      验证：`pnpm --filter @citely/server test` 全绿；故意插入禁语后该测试转红。
- [x] 23. `docs` `docs/demo-ui.md`：改写为「ERC-8183 任务生命周期」主线——三视图表更新、
      新增四拍/事件映射表（照抄 §3.1）、六步握手降为"四拍下的签名明细"小节
      （**谁签哪一步的表格原样保留**）、新增 `GET /app/api/jobs/:id` 端点说明、
      "Known limitation" 段落原样保留。
- [x] 24. `docs` `README.md` / `README.zh-CN.md`：仅更新演示 UI 的一句话描述
      （"六步握手"→"提交任务、拿回已完成的 verification"），链接与其余内容不动。
- [x] 25. `docs` `CHANGELOG`（若仓库有）：记录本次为**纯演示层改动**，
      注明无 schema 变更、无版本 bump、无合约语义变更。
      **执行记录：本仓库没有 CHANGELOG 文件**，故该记录写入 `docs/demo-ui.md`
      的端点小节与 `.claude/impl-result.md`；本次确认无 schema 变更、无版本
      bump、无合约语义变更。

---

## 8. 测试要求（QA 据此验收）

### 8.1 现有测试基线

- webapp 三件套**目前没有任何行为测试**，只有 `demo-flow.test.ts` 里的静态资源测试
  （200 + content-type + 长度 > 100）。仓库无 `vitest.config.*`，无 jsdom/happy-dom/playwright。
- 因此本次的自动化验收落在两处：**后端端点单测** + **前端文案/结构静态断言**；
  DOM 行为靠**手动清单**（下 §8.4）。

### 8.2 前端测试手段选型（唯一涉及第三方依赖的选型）

| 方案 | 能测到什么 | 成本 | 许可证 | 维护活跃度 | 结论 |
|---|---|---|---|---|---|
| **T1 静态文本断言**（读文件文本 + 正则） | 措辞红线、四拍/事件名齐备、禁语、免责声明 | 零新依赖，~40 行测试 | 不适用 | 不适用 | **采纳**（步骤 22） |
| T2 jsdom + vitest `environment: "jsdom"` | 真渲染 DOM、真 XSS 断言、时间线状态机 | 新依赖 jsdom（需建 `vitest.config`），且 `app.js` 是全局 `<script>`、非模块，**必须改源文件加测试出口**才能 import | MIT | 高（长期活跃，v27 系列） | **不采纳**（为测试改产品源文件的形态，收益 < 侵入） |
| T2' happy-dom | 同 T2，更快更轻 | 同上（同样要改源文件） | MIT | 高 | 同上不采纳 |
| T3 Playwright 端到端 | 真浏览器 + 真钱包流程 | 需真实链/钱包/长跑，演示期不可行 | Apache-2.0 | 高 | **不采纳** |

> 若后续 demo UI 继续长大（超过 ~1000 行），建议单开一个设计任务评估 T2：
> 前提是先把 `app.js` 拆成"纯函数模块 + 引导脚本"两层，那时 import 就不再是侵入。

### 8.3 必过的自动化用例（阻断项）

后端（`demo-flow.test.ts` 扩写）：

1. `GET /app/api/jobs/42` → 200；body 含 `job_id`/`status`/`client`/`provider`/`evaluator`/
   `budget_atomic`/`expired_at`/`tx`；`status` ∈ 六态白名单。
2. `client` 归零 → 404 `job_not_found`。
3. id 非法（`abc`、`1e5`、80 位数字）→ 400，且 `getJob` **调用次数为 0**。
4. `getJob` 抛含哨兵串的错误 → 502，且响应体**不含**哨兵串（防 RPC URL/key 外泄）。
5. `tx` 三/四个键来自 txLog 替身，且替身收到的键 == `idempotencyKey(jobId, action)`。
6. TTL：同一 jobId 连打 3 次，`getJob` 只被调 1 次；把假时钟推进 10001ms 后再打，变 2 次。
7. **回归**：不给 `demo` 选项时 `/app/api/jobs/42` 仍是 404（最小部署不多长口子）。
8. **回归**：`/app/api/config` 的既有断言（无 64 位 hex、无 `PRIVATE_KEY`）依旧通过。
9. **回归**：`/app`、`/app/app.js`、`/app/style.css` 三件套 200 + content-type 不变。

前端（`webapp-copy.test.ts` 新建）：

10. footer 免责声明原句存在于 `index.html`。
11. `app.js` 含四拍标签与四个事件名。
12. `app.js` + `index.html` 均不含禁语（`authorizes the payment` / `Citely authorizes` /
    `is compliant` / `legally compliant` / `legal opinion`，忽略大小写）。
13. `app.js` 仍含 `proof, not an instruction` 与 `setBudget` 的 provider 受限说明。

全仓：

14. `pnpm typecheck` 通过；`pnpm lint` 通过；`pnpm test` 全绿（无新增跳过用例）。

### 8.4 手动验收清单（QA 逐条勾，建议录屏留证）

环境：`X402_SELL_MODE=off` 本地起服务，或直接开演示环境。

- [ ] M1 `#/` 服务页：header 出现 8183 chip，可点开 arcscan 合约地址页。
- [ ] M2 `#/new`：首屏文案是"提交任务"，四拍时间线在表单下方，六个明细行齐全、
      `setBudget` 行仍标 `citely` + provider-only 说明。
- [ ] M3 跑一次完整流程：四拍依次点亮；每笔 tx 可点开 arcscan 且交易存在。
- [ ] M4 中途拒签一笔（钱包点 reject）：对应拍变 failed，`Retry failed step` 仍能续跑，
      且不会重复发已成功的交易。
- [ ] M5 跑完自动跳转案件页：**第一屏就是 verification hero**，含 3/3、reasonHash、
      complete tx 链接、deliverable(sa_hash)。
- [ ] M6 直接开一个历史案件（`#/case/rehearsal-msb1uis5`，不连钱包）：hero 与时间线均渲染，
      时间线标注 "read from chain"。
- [ ] M7 断网/停 RPC 模拟链读失败：案件页仍完整渲染，时间线标注
      "on-chain state unavailable — shown from the case record"，**页面不空白、不报错**。
- [ ] M8 XSS：用 `deal_id` = `x"><img src=x onerror=alert(1)>`（在 128 字符与
      `^[A-Za-z0-9_-]+$` 闸允许范围内则改用能通过闸的变体）跑或直接打开构造的 case id，
      确认无弹窗；再手改 sessionStorage 的 tx 值为脚本串刷新，确认无弹窗且该 tx 不渲染。
- [ ] M9 失败态：构造/挑一个 `verification.passed === false` 或 `settlement.action === "reject"`
      的案件，确认 hero 是红色失败文案、时间线终局拍显示 Rejected，**绝不显示 Verified**。
- [ ] M10 措辞终检：整站搜不到 "authorize/approved/compliant/legal advice(除免责声明原句)"；
      hero 的两句限定语在位。
- [ ] M11 窄屏（375px）下时间线不溢出、hash 不撑破布局。

### 8.5 回归红线（任一条不满足即打回）

- `runFlow()` / `readForm()` / `/app/api/encode` / `setBudget` 端点的行为差异 = 0；
- `POST /cases` 的请求体构造差异 = 0；
- footer 免责声明、SA banner 原句、Model verdicts 小字差异 = 0；
- 未触碰 `chain` / `engine` / `verifier` / `marketplace` 任何文件；
- 未新增任何运行时依赖（`package.json` 的 `dependencies` 零改动）。

---

## 9. 涉及文件清单

**改动**

| 文件 | 包 | 性质 |
|---|---|---|
| `packages/server/src/webapp/index.html` | webapp | nav 文案、chain-chip 容器（footer 不动） |
| `packages/server/src/webapp/app.js` | webapp | 主要工作量：时间线组件、hero、两视图重排、链接与形状闸 |
| `packages/server/src/webapp/style.css` | webapp | 新增 timeline/hero/chip 样式 |
| `packages/server/src/demo-api.ts` | server | 新增 `JobStatusView` + `jobStatus` + TTL 缓存 + `txLog` 依赖 |
| `packages/server/src/app.ts` | server | 新增 `GET /app/api/jobs/:id` 路由 |
| `packages/server/src/index.ts` | server | `SqliteIdempotencyStore` 提升为共享实例并注入 demo |
| `packages/server/src/demo-flow.test.ts` | server | 新增端点用例 |
| `docs/demo-ui.md` | docs | 改写为 8183 生命周期主线 |
| `README.md` / `README.zh-CN.md` | docs | 一句话描述更新 |

**新建**

| 文件 | 包 | 性质 |
|---|---|---|
| `packages/server/src/webapp-copy.test.ts` | server | 文案红线静态断言 |
| `docs/design/demo-ui-8183-narrative.md` | docs | 本设计文档 |
| `docs/design/current-task.md` | docs | 本文档副本（Stop hook 依据） |

**明确不动**：`packages/{chain,engine,verifier,marketplace}/**`、`rubrics/**`、
`scripts/**`、所有 `package.json`。

---

## 10. 执行模式建议

**这不够格"单文件小修"。** CLAUDE.md 的豁免条件是"不跨包、不动接口"，本任务
跨 `webapp/` 三个静态文件 + `server` 三个 TS 文件，且**新增了一个 HTTP 接口**
（`GET /app/api/jobs/:id`）与一个内部接口变更（`DemoApi` 增方法、`createDemoApi` 增依赖）。
必须走完整流水线（设计 → 执行 → 双审查 → 文档 → 提交）。

**建议：单 implementer 串行执行**，而不是 agent team。理由：

1. 总量约 380 行，其中前端 3 个文件是**同一段叙事**的三个切面（HTML 结构 / JS 渲染 / CSS 类名），
   拆给两个人做会产生大量类名与 DOM 结构的对齐往返，协调成本 > 并行收益；
2. 后端只有一个端点，工作量约占 25%，不足以撑起一个独立 teammate；
3. 阶段一（后端）与阶段二~四（前端）之间的接缝已经在 §4.1.1 冻结成一个 JSON 形状，
   串行执行时前端可以先按该形状写、后端后补也不会返工。

**若一定要并行**（例如工期极紧），唯一合理的切法是沿冻结接缝二分：
teammate-A 做步骤 1–6（server 端点 + 测试），teammate-B 做步骤 7–21（webapp 全部），
步骤 22–25 由主导收尾。**不要三分**（把 css 或 html 单独分出去必然返工）。

**双审查关注点**：
- qa-reviewer：§8.3 的 14 条自动化用例是否全部落地并通过；§8.5 回归红线的 diff 核对
  （尤其"卡片整块移动、内部零字符差异"）；降级路径（M7）是否真的被实现而不是靠运气；
- security-auditor：§6 全节，重点是 502 不回显 RPC 错误、sessionStorage 回读过形状闸、
  新端点不含任何 env 派生字段、`${` 插值的 esc 纪律、禁语测试是否真的能红。

---

## 11. 核心结论摘要

1. **问题诊断**：当前案件页把用户真正要的交付物（verification 三检）排在倒数第二张卡，
   8183 只以一行 jobId 文本出现；`submit` 这笔最能体现"提交任务"的链上交易**在 UI 上完全不可见**。
2. **推荐方案 B**：前端叙事重构（四拍 8183 生命周期时间线 + verification 提为案件页 hero）
   **加一个只读端点** `GET /app/api/jobs/:id`（链上 `getJob` + 从 `tx_log` 读回
   `setBudget`/`submit`/`complete` 三笔 tx）。方案 A（纯前端）被内建为 B 的**降级路径**：
   链读失败时页面照常渲染，因此 B 的工期风险等于 A。
3. **否决方案 C**（`getLogs` 事件流 + 独立 Job 视图）：增量信息价值低，且正撞在仓库已实证的
   Arc 公共 RPC 限流坑上，演示当场挂掉的风险不可接受。
4. **零新依赖、零 schema 变更、零版本 bump**：不动合约/ABI、不动 SA schema、不动 SQLite DDL、
   不动 `GET /cases/:id`、不动 agent card。三个方案都不引入任何运行时依赖。
5. **不变量全保**：无新合约调用语义（新端点是只读 GET）；`setBudget` 的 provider-only 事实
   在 UI 上仍显式标注（只是从"第 3 步"降为"第 1 拍下的明细行"）；SA 措辞、免责声明、
   "业务内容不上链"表述全部逐字保留，并新增 hero 限定语「三项确定性检查，不是法律结论」
   与「链上只有哈希，文档在链下」。
6. **最强的一处新增证据，零成本**：`verification.reasonHash` 已经在快照里但从未展示——
   它就是链上 `complete(jobId, reason)` 的第二个参数，把它和 complete tx 并排放在 hero，
   任何人都能自行核对。这一条即使只做方案 A 也应当做。
7. **不够格"单文件小修"**：跨 webapp 三件套 + server 三个 TS 文件 + 新增一个 HTTP 接口，
   必须走完整流水线。**建议单 implementer 串行**（约 380 行，前端三文件是同一段叙事的三个切面，
   拆人协调成本大于并行收益）；若工期紧，只允许沿 §4.1.1 冻结的 JSON 接缝二分。
8. **测试策略选型**：采用「后端端点单测（9 条）+ 前端文案红线静态断言（4 条）+ 手动清单
   （11 条，含 XSS 与降级）」；**不引入 jsdom/happy-dom**——因为 `app.js` 是全局 `<script>`
   而非模块，为可测性改产品源文件的形态，收益小于侵入（理由与后续条件见 §8.2）。

### 需要由人拍板的判断

- **P1（选型）**：确认走方案 B（含新端点）还是收敛到方案 A（纯前端、零后端改动）。
  A 的代价是案件页看不到 `submit` 那笔交易、也拿不到链上当前状态。
- **P2（文案）**：nav 与建单页把主词从 "case" 改为 "job"（`Start a case` → `Submit a job`）
  是否接受？本设计的口径是：**8183 层叫 job，合规记录层仍叫 case，一个 job 对应一个 case**，
  并在 UI 上明说这个映射。路由 `#/new` / `#/case/<id>` 不变，旧链接不失效。
- **P3（信息取舍）**：案件页 hero 只放 verification（三检 + reasonHash + complete tx），
  把 exit 路由、SA hash、valid until 等降到页面底部的 "Case record" 卡——
  是否接受这种"交付物优先、审计信息靠后"的取舍？
- **P4（执行模式）**：接受"单 implementer 串行"的建议，还是坚持 agent team 默认模式
  （若坚持，按 §10 的二分法分工）。
- **P5（范围）**：确认**不**在本次修复"服务端不校验请求方是否为 Job 的链上 client"这一
  已知限制（需请求签名，属独立任务）。
