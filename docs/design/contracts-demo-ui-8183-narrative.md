# 集成合约摘录：演示 UI 8183 叙事重构

来源：`docs/design/demo-ui-8183-narrative.md`（§3.1 / §4.1，其中链上事件与状态照录
`contracts-vertical-slice.md` §2）。本任务**零合约语义变更、零 schema 变更**，
本文档只固化实现各方必须遵守的接口与映射，不得现场发明。

## 1. 8183 Job 生命周期 ↔ UI 四拍映射（照录，不发明）

| 拍 | UI 文案 | 链上事件 | 事件后 JobState | 谁签 |
|---|---|---|---|---|
| 1 | Job created | `JobCreated(jobId, client, provider, evaluator, expiredAt, hook)` | `open` | 用户钱包（client）；内含 `BudgetSet`（provider-only） |
| 2 | Escrow funded | `JobFunded(jobId, client, amount)` | `funded` | 用户钱包（approve + fund） |
| 3 | Work submitted | `JobSubmitted(jobId, provider, deliverable)` | `submitted` | Citely（provider）；deliverable = sa_hash |
| 4 | Verified & completed | `JobCompleted(jobId, evaluator, reason)` | `completed` | 验证器（evaluator）；reason = reasonHash |

终局替代形态（必须如实渲染）：`rejected`（`JobRejected`）、`expired`（`JobExpired` + `Refunded`）、停在拍 3 = Awaiting evaluator。链读失败时未证明的拍显示 unknown 并标注 "on-chain state unavailable"，**禁止推测**。

## 2. 新增只读端点契约

```
GET /app/api/jobs/:id
  200 → JobStatusView
  400 → { error: "invalid_job_id", message }    // 复用 JOB_ID_PATH_PATTERN
  404 → { error: "job_not_found", message }     // DemoApiError(404)，client 归零地址即不存在
  502 → { error: "chain_unavailable", message } // 固定安全串，不回显 RPC 原始错误
```

`JobStatusView`（字段与设计 §4.1.1 逐字一致；金额/时间一律十进制字符串）：

```ts
export interface JobStatusView {
  readonly job_id: string;
  readonly status: JobState; // "open"|"funded"|"submitted"|"completed"|"rejected"|"expired"
  readonly client: Address;
  readonly provider: Address;
  readonly evaluator: Address;
  readonly budget_atomic: string;
  readonly expired_at: string;
  readonly tx: {
    readonly set_budget?: Hex;
    readonly submit?: Hex;
    readonly complete?: Hex;
    readonly reject?: Hex;
  };
}
```

硬性约束：
- `tx` 键必须用 chain 包导出的 `idempotencyKey(jobId, action)` 构造，server 不得自拼字符串；
- `jobStatus` 带 `JOB_STATUS_TTL_MS = 10_000` 内存缓存（只缓存成功结果，Map 上限 200，插入序淘汰），防公共 RPC 放大；
- `SqliteIdempotencyStore` 在 `main()` 建一次、`buildJobClient` 与 `createDemoApi` 共用同一实例；
- 该端点不进 agent card；全局限流中间件自动覆盖。

## 3. 措辞红线（审计逐条查，来源设计 §3.3）

1. footer 免责声明原句不动：`Results are compliance check statuses compiled from public legal sources. Not legal advice.`
2. SA 口径：条件证明，由钱包按自有预设策略核验执行；禁 `authorize(s the payment)` / "Citely approves"；`The SA is proof, not an instruction` 保留。
3. verification 禁写成 compliant/legal/approved/cleared；hero 必须含限定语（如 *Three deterministic checks on the deliverable — not a legal conclusion.*）。
4. 链上只有 sa_hash 与 reasonHash，相关文案必须写明 "hash only, the document stays off-chain"。
5. `setBudget` 保留"链上限定 provider"事实表述。
6. 每个步骤明细行保留 `your wallet` / `citely` / `agent` 签署者标签。

## 4. 已拍板决策（2026-08-02）

- 方案 **B**（前端重构 + 只读端点，A 为内建降级路径）；
- 命名：8183 层叫 **job**，合规记录层仍叫 **case**，路由 `#/case/<id>` 不变；
- 案件页 hero 只放 verification 交付物，exit/SA hash/有效期降入底部 Case record；
- 执行模式：**单 implementer 串行**执行设计文档 25 步清单；
- 本次**不修**"服务端不校验请求方是否为 Job 链上 client"的已知限制（维持 docs/demo-ui.md 的 Known limitation）。
