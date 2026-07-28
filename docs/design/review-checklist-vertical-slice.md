# 合并审查清单：纵切阶段

> 主导（或未参与该 diff 的 teammate）按本清单过**全量 diff**。
> 正确性与安全两份清单**一次审查同时出具**，全过后才创建
> `.claude/review-passed` 与 `.claude/security-passed` 两枚标记。
> 依据：`contracts-vertical-slice.md`、`llm-provider-openai.md`、v2.2 架构不变量。

## A. 架构不变量（违反即打回，不接受"演示阶段先这样"）

- [ ] **A1 零自定义合约**：链上只用 8183 参考合约与 Circle 标准件。
      diff 里**没有**任何自写 `.sol`；若有部署脚本，部署的是**原样参考合约**（逐字节比对源码，
      不许有"顺手加个 modifier"）。
- [ ] **A2 判定回路无 LLM**：Policy Engine 计算 `condition` 的函数**签名里不接收**
      判定器 verdict/confidence。grep 全仓：`PASS`/`HOLD`/`ESCALATE` 的赋值点
      是否全部可追溯到 `ModuleResponse.settlement_constraints` 或 `overall`。
      判定器输出**只**流向卷宗呈现与 `legs[].confidence` 映射。
- [ ] **A3 客户资金零接触**：全仓 grep 转账目的地址，确认**没有任何一笔** USDC 转账
      的 `to` 是我方运营/验证器地址。采购钱包只付 Module 费用，不收客户款。
- [ ] **A4 链上只有哈希/签名/状态/资金**：`submit()` 的 `deliverableHash` 是 sha256，
      `reasonHash` 同理。确认**没有**把 SA 正文、材料、报告原文、案件描述明文写进
      `description` 或任何 calldata。`createJob` 的 `description` 字段内容需逐字审。
- [ ] **A5 材料是数据不是指令**：
      - `renderSystemPrompt` 的**类型签名里不含材料类型**（编译期保证）
      - `buildUserPayload` 实现体内**只有一次 `JSON.stringify`**，无 `+` 拼接、无模板插值
      - `AdjudicationRequest.systemPrompt`(string) 与 `untrustedData`(Record) 类型不同，传错编译不过
      - 沙箱解析器与 prompt 渲染在不同文件，无互相 import
- [ ] **A6 状态三纪律**：
      - SQLite 是唯一真相源（链上事件只对账，不作为状态来源）
      - **轮询不订阅**：grep `watchEvent` / `watchBlocks` / `wss://` / `subscribe`，应为零命中
      - 幂等：每个链上写方法入口都有 `lookup(jobId+action)`，命中即返回不发交易

## B. 合约符合性

- [ ] B1 `JobClient` / `X402Client` / `IdempotencyStore` 签名与合约 §2 §3 **逐字一致**
- [ ] B2 状态机字符串与合约 §3 **逐字一致**（`intake/decomposed/assessing/conditions_ready/
      submitted/settled/rejected`；partyTask 四态；verdict 五态）。grep 有无拼写漂移
- [ ] B3 判定器输出 domain 形态与合约 §4 一致；线格式哨兵值 `"none"` **只存在于 `llm/` 与
      `schema.ts` 内部**，`toDomain()` 之后全仓不应再出现 `gray_type === "none"`
- [ ] B4 SA schema 覆盖 v2.2 §4.2 全部字段；`deliverableHash = sha256(canonicalJson(SA))`
- [ ] B5 账本 `category` 枚举六值齐全，金额一律 6 位小数原子单位 **bigint**
      （grep `number` 类型的金额字段——浮点金额一律打回）
- [ ] B6 **`canonicalJson` 全仓只有一份实现**（grep 键排序逻辑，防止 SA 哈希与 cache key 用了两套）
- [ ] B7 依赖方向单向：`packages/chain/package.json` 内**无** `@citely/engine`
- [ ] B8 依赖白名单：chain = viem/@x402/*/@circle-fin/x402-batching；
      engine = openai(**pin `~6.49.0`，不是 `^`**)/better-sqlite3。
      **无 zod、无 ajv、无 `openai/helpers/zod`**（后者会把 cache key 绑到第三方库版本）

## C. 安全

- [ ] C1 **密钥只走 env**：grep `0x[0-9a-fA-F]{64}`、`sk-`、`PRIVATE_KEY=` 字面量，
      源码与测试里应为零命中。`.env` 不在 diff 里（`git ls-files` 确认）
- [ ] C2 **四密钥物理分离**：判定器进程不持有任何链上私钥；验证器进程不持有
      `OPENAI_API_KEY`；采购钱包私钥只出现在 x402 客户端
- [ ] C3 **错误不泄密**：所有对外抛出/日志的错误都过 `redactSecrets`；
      验证一条负向测试（构造含私钥的错误，断言输出是 `[REDACTED]`）
- [ ] C4 **材料不进日志**：只记 `material_sha256`。grep 日志调用点
- [ ] C5 注入防线：A1–A8 八条断言全部存在且通过，**A7 恶意模型必须在**
- [ ] C6 `source_refs` 白名单过滤生效（注入最想达成的效果之一是伪造法源引用）
- [ ] C7 判定器 schema 里**无自由文本字段**（无 `reason`/`summary`）——
      材料里的指令文本没有合法出口进入判定结果
- [ ] C8 `cache_only` 未命中是**抛错中止**，不是静默降级
- [ ] C9 兜底路径（`unverifiable`）由确定性代码写死，且**不写入 golden cache**
- [ ] C10 `pnpm audit` 无高危；lockfile 入库；新增依赖逐个过目

## D. 对外措辞（红线）

- [ ] D1 SA 措辞是"条件证明，由钱包按自有预设策略核验执行"
- [ ] D2 grep **`Citely authorizes`** —— 全仓零命中（含注释、测试、演示文案）
- [ ] D3 免责声明在 API 响应与对外文档中保留：输出为基于公开法源整理的检查项状态，
      不构成法律意见
- [ ] D4 确定性话术：不许出现"我们的 LLM 是确定性的"或声称一个未生效的
      `temperature` 参数。对外口径是"可复现性由 golden cache 提供，不是由模型提供"

## E. 工程质量

- [ ] E1 `pnpm test` / `pnpm typecheck` / `pnpm lint` 三绿（贴实际输出，不许口头说通过）
- [ ] E2 单测**零网络零 API key**；spike 脚本不进 CI
- [ ] E3 测试与代码同放；每个新增公共接口有对应测试
- [ ] E4 无 `any`；`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 下无 `@ts-ignore`

## 提交纪律（审查通过后）

1. 对本次改动文件跑 `shasum -a 1` 存快照；创建两枚标记
2. **`git commit` 单独成条命令**——绝不写 `ls 标记 && git commit`（hook 在命令执行前
   就消耗标记，预检会自杀）
3. 提交前重跑 `shasum -a 1` 与快照比对，任一不符即重审
4. commit message 引用 `docs/design/contracts-vertical-slice.md` 与
   `docs/design/llm-provider-openai.md`

## 变更记录

- 2026-07-27：初版（主导，据合约与 llm-provider-openai.md 产出）。
