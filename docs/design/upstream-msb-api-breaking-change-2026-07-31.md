# 上游 msb-agent API 破坏性变更（2026-07-31）

**上游**：`web3yaso/msb-agent` commit `0d17ac0`（含 PR #3 `7c3c053`）
**上线时间**：2026-07-31，已自动部署到 `https://msb-agent-production-769d.up.railway.app`
**性质**：破坏性变更，**当前已在生产生效**
**状态**：待本仓库适配；适配完成后请在此标注对应 commit。

> 本文由上游整理后落盘到本仓库。文中「实测复现」一节的结论是对本仓库
> `packages/chain` 的真实代码跑出来的，不是照着上游 schema 推断的。

---

## 一句话结论

**deal-desk 的真实（非 dry-run）调用路径现在是坏的，而且失败发生在付款成功之后**——
钱扣了，`assertModuleResponse` 抛 `ChainError`，拿不到结果。

## 实测复现

拿 msb-agent 当前生产形态的响应（us-msb，6 条 check）喂给 deal-desk 的校验器：

```
ChainError: Module 响应字段 checks[1].result 取值非法：NOT_APPLICABLE（应为 PASS|HOLD|ESCALATE）
```

抛错点在 `packages/chain/src/x402-client.ts:373`：

```ts
const result = await gw.pay(...);              // ← 付款已成功，USDC 已扣
const response = assertModuleResponse(result.data);   // ← 在这里抛
```

**每个模块的每次调用都会命中**，不是边界情况：只要有规则未被触发，
它就会返回 `NOT_APPLICABLE`，而任何一笔真实交易都不可能触发全部规则。
us-msb 的典型交易 6 条 check 里有 2 条是 `NOT_APPLICABLE`。

---

## 变更了什么

### 1. `CheckStatus` 枚举从三值扩容为四值（**这是打爆你们的那条**）

```
PASS | HOLD | ESCALATE  →  PASS | HOLD | ESCALATE | NOT_APPLICABLE
```

**动机**：原先 `PASS` 同时表示三种完全不同的情况——规则未触发、调用方提交了材料、
数值未达门槛。下游无法区分"这条规则不适用"和"这条规则通过了"。
现在规则条件未触发、或已知完整数值低于适用门槛 → `NOT_APPLICABLE`。

**`NOT_APPLICABLE` 不是 `PASS` 的同义词，更不是放行信号。**
它的含义是「本模块规则集对这笔交易没有可适用的检查项」。

### 2. 每条 check 新增 `basis` 字段（六值）

`not_applicable` / `caller_assertion` / `missing_evidence` /
`deterministic_threshold` / `insufficient_aggregate_data` / `manual_review`

其中 **`caller_assertion` 明确表示"调用方自述、未经独立核验"**——
本服务没有连接任何外部注册或许可数据库，非空材料只能标记为调用方声明。

### 3. 响应新增三个必填字段

| 字段 | 位置 | 含义 |
|---|---|---|
| `engine_version` | 根级 | 引擎语义版本，当前 `"1.0.0"` |
| `hash_scheme_version` | 根级 | evidence_hash 预映射方案版本，当前 `"2"` |
| `evaluated_check_count` | `settlement_constraints` | 非 `NOT_APPLICABLE` 的 check 数量 |

### 4. 全部 `evidence_hash` 取值改变

预映射升级为 scheme 2：版本上下文进入前像，`checks` 段从 `{id,result}`
扩展为 `{id,result,basis}`。**任何已存档的 evidence_hash 都无法用新引擎复现**。
可读 `hash_scheme_version` 区分新旧方案。

---

## 你们要改什么

### 必改（不改就一直是坏的）

**① `packages/chain/src/types/module.ts:14`**

```ts
export type CheckStatus = "PASS" | "HOLD" | "ESCALATE" | "NOT_APPLICABLE";
```

**② `packages/chain/src/validate/module-response.ts:15`**

```ts
const CHECK_STATUSES: readonly CheckStatus[] = ["PASS", "HOLD", "ESCALATE", "NOT_APPLICABLE"];
```

改这两处就能恢复调用。`packages/chain/src/x402-client.test.ts:153` 那条
用 `"MAYBE"` 验证非法值被拒的测试**仍然有效**，不用动。

**③ 放行判据必须收紧**

如果 Policy Engine 现在按「`blocked_check_ids` 与 `escalated_check_ids` 都为空 → 放行」
判断，**这个判据现在不安全了**。

`activity` 是调用方完全可控的请求字段。把一笔真实的 money_transmission 交易
填成 `check_cashing` 去调 sg-msb / eu-msb，法域守卫不会拦（交易方确实在该法域内），
结果是：全部规则不匹配 → HTTP 200、`overall = NOT_APPLICABLE`、
两个阻断列表**都为空**，并附一个**密码学上完全真实、可离线复算验证通过**的
`evidence_hash`。只验 hash + 看阻断列表的结算逻辑会直接放款。

新判据：

```ts
const canSettle =
  constraints.blocked_check_ids.length === 0 &&
  constraints.escalated_check_ids.length === 0 &&
  constraints.evaluated_check_count > 0;      // ← 新增这一条
```

`evaluated_check_count === 0` 表示本模块规则集**没有评估这笔交易**，不得放行；
此时应视为"需改用其他法域模块或转人工"。

### 建议改

**④ `demo/fixtures/module-response.ts:123` 起的合成替身**

五条 check 目前全是 `result: "PASS"`。在新引擎下，其中未被触发的规则应当是
`NOT_APPLICABLE`。不改的话，`--dry-run` 与真实调用的语义会**系统性地不一致**——
而"把不适用误当成通过"正是这次变更要消灭的那类误读。
建议按新形态重新构造（或等一次真实调用后回填录制，该文件头部注释已预留了这个计划）。

**⑤ 已存档的 `evidence_hash` 全部失效**

对账、缓存、审计留痕里的旧值不会再匹配。建议按 `hash_scheme_version` 分桶保存。

### 不用改

校验器是**白名单读取**（按 key 逐个取值），不是 strict 全量校验，
所以新增的 `basis` / `engine_version` / `hash_scheme_version` /
`evaluated_check_count` 会被**静默忽略**，不会导致解析失败。
只有枚举扩容那条是硬伤——`readEnum` 遇到未知值必抛。

（如果将来要读 `evaluated_check_count`，记得在
`packages/chain/src/validate/module-response.ts` 的 `readConstraints` 里加读取，
以及 `types/module.ts` 的 `SettlementConstraints` 加字段。）

---

## 语义速查

| `overall` | 含义 | 可否放行 |
|---|---|---|
| `PASS` | 所有适用检查项均通过 | 可 |
| `HOLD` | 有检查项缺少必要证据 | 否 |
| `ESCALATE` | 有检查项无法确定性判定，需人工 | 否 |
| `NOT_APPLICABLE` | **本模块规则集对该交易无适用检查项** | **否**——不代表合规 |

聚合优先级：`ESCALATE > HOLD > PASS > NOT_APPLICABLE`。
`NOT_APPLICABLE` 为中性，不阻断其他适用检查；仅当全部检查项都不适用时，
`overall` 才是 `NOT_APPLICABLE`。

---

## 参考

- 上游 API 文档（含 basis 取值表、聚合语义、evidence_hash 完整定义）：
  `docs/api.md` / `docs/api.zh-CN.md`
- 上游 CHANGELOG「破坏性变更」小节
- 上游 Issue #1（本次变更的需求来源）
- 公网真实付费冒烟验证：结算 ID `f22febf0-8a7a-4649-bc1d-aa9f9f168e7b`，
  `evidence_hash` `55b687d6d79d24602eca450a353a5dc6577367e3927256e1ab13e8213fdf0d05`

---

> 本服务输出为基于公开法源整理的检查项状态，**不构成法律意见**。
