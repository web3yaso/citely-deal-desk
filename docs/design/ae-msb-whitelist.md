# 接入上游 ae-msb 模块（进模块校验器白名单）

> 状态：设计稿，待主导确认后交 Codex 执行
> 作者：architect subagent · 2026-08-02
> 影响包：`@citely/chain`（类型 + 白名单）、`@citely/server`（法域表 + 配置）、
> `@citely/verifier`（认证清单，**运维动作，需人拍板**）、文档

---

## 1. 背景与目标

### 1.1 事实基线（已实证，直接采用）

- 上游 msb-agent 已上线第 5 个法域模块 `ae-msb`（UAE），规则文件版本 `2026.08.1`，
  6 条规则，单价 **1.000000 USDC**（线上 `GET /modules` 可核，免费端点）；
- 对既有 4 模块是**非 breaking** 变更：响应形状、`hash_scheme_version`、
  `engine_version`、`CheckStatus` 四态一律未动；
- Deal Desk 侧当前把"已上线模块"写死在三处：
  - `packages/chain/src/types/module.ts:11` — `ModuleId` 联合类型；
  - `packages/chain/src/validate/module-response.ts:14` — `MODULE_IDS` 运行时白名单
    （`assertModuleResponse` 用它校验 `module` 与 `settlement_constraints.module`）；
  - `packages/server/src/constants.ts:58-62` — `MODULE_JURISDICTIONS`
    （`Record<ModuleId, string>`，类型扩容后编译器强制补行）；
- 运行时选哪个模块靠 `MODULE_ID` 环境变量：`packages/server/src/config.ts:351`
  默认 `us-msb`，配置层类型是 `string`（`config.ts:171`），
  `packages/server/src/index.ts:193` 处**硬 cast `as ModuleId`**，无运行时校验
  （主导给的行号 185 是旧版；当前文件为 193，实现时以 `as ModuleId` 字面为准）。

### 1.2 目标

1. 让 `ae-msb` 成为 Deal Desk 认识的合法模块 id：付费响应能过校验器、
   agent card 如实列出 5 个法域、`MODULE_ID=ae-msb` 能正常起服务；
2. 顺带把"白名单只有一份真值"的编译期保证补上（现状两处手写、无穷尽性检查）；
3. **不做更大重构**：不引入模块注册表、不做多模块并行采购、不写 UAE rubric。

### 1.3 明确不做

- 不实现"按交易方国别自动选模块"（当前架构就是单模块/单进程，靠 `MODULE_ID`）；
- 不新增 `rubrics/ae-msb.json`（见 §7.2 核查结论：缺它不会崩）；
- 不改 `evidence_hash`、`NOT_APPLICABLE` 语义、`evaluated_check_count` 放行判据。

---

## 2. 技术选型

问题只有一个：**"已上线模块集合"这份真值该怎么表达**。三个候选：

| 方案 | 做法 | 优点 | 缺点 | 依赖/许可证/活跃度 |
|---|---|---|---|---|
| **A. 枚举扩容（现状形态）** | `ModuleId` 联合类型 + `MODULE_IDS` 常量数组各加一个字面量 | 改动最小（2 行 + 1 行法域表）；`Record<ModuleId,string>` 让漏配变编译错误；零新依赖；校验仍是"付费响应边界上的显式白名单" | 真值写在两处，靠人保持同步；加模块要发版 | 无新依赖（现有 TS 5.x，Apache-2.0；viem MIT，活跃） |
| **A′. 枚举扩容 + 单一真值加固**（推荐） | 同 A，但 `MODULE_IDS` 改 `as const satisfies readonly ModuleId[]`，并加一行编译期穷尽性检查 `type _Covered = Exclude<ModuleId, (typeof MODULE_IDS)[number]> extends never ? true : never` | A 的全部优点 + **漏了任一处都编译不过**；再加 `isModuleId()` 让 `MODULE_ID` 环境变量可 fail-fast 校验 | 比 A 多约 8 行 | 同上，零新依赖 |
| **B. 运行时可配白名单** | 删掉联合类型，`ModuleId = string`，白名单从 `MODULE_IDS_ALLOWED` 环境变量读 | 上游加模块无需发版 | **把编译期保证换成了运行时字符串**：`MODULE_JURISDICTIONS` 不再强制补行、`x402-client` 的 `check(moduleId)` 失去类型约束、拼进 URL 的值来自环境变量且无字面量兜底（付费请求 + SSRF 面）；测试无法穷举 | 零新依赖，但**降低安全等级**，与"付费响应边界必须显式白名单"的既有纪律冲突 |
| **C. 引入 zod，与上游共享 schema** | `chain` 包引入 zod，用 `z.enum([...])` 同时产出类型与运行时校验 | 单一真值天然成立；与 msb-agent 侧写法一致 | **破坏 chain 包的依赖白名单**（该包刻意不引 zod，`validate/module-response.ts:141` 有逐字说明"本包不引入 zod（依赖白名单），因此手写 type guard"）；为一个 5 元素枚举引入一个运行时依赖，收益不成比例 | zod：MIT，维护非常活跃（周下载千万级）。技术上没问题，**但违反本仓既定依赖纪律** |

**推荐：A′。**

理由：
1. 这次变更的本质是"名单多一个成员"，不是"名单机制不对"。B/C 都是在换机制，
   属于技术选型变更，按流程得回到第 1 步重新评审，且都要付出实实在在的代价
   （B 降安全等级、C 破依赖白名单）；
2. A 唯一的真实弱点是"两处手写可能漏"，而 A′ 用 8 行类型代码把它变成编译错误，
   成本远低于换机制；
3. `isModuleId()` 同时解决了 §5.2 的硬 cast 问题——`as ModuleId` 是当前唯一一处
   "未经校验的字符串被当成受信任枚举"，而这个字符串会被拼进**要花钱的** URL。

---

## 3. 模块划分与接口定义

### 3.1 `@citely/chain`（类型 + 白名单，唯一真值所在）

`packages/chain/src/types/module.ts`：

```ts
/** 已上线的 Module ID（msb-agent `ModuleIdSchema`）。5 个法域，ae-msb 于 2026-08 上线。 */
export type ModuleId = "us-msb" | "uk-msb" | "eu-msb" | "sg-msb" | "ae-msb";
```

`packages/chain/src/validate/module-response.ts`：

```ts
/** 已上线的 Module ID 全集（msb-agent `ModuleIdSchema`）。 */
export const MODULE_IDS = ["us-msb", "uk-msb", "eu-msb", "sg-msb", "ae-msb"] as const satisfies
  readonly ModuleId[];

/**
 * 编译期穷尽性检查：`ModuleId` 里任何一个成员没进 MODULE_IDS 就编译不过。
 * 不是装饰——白名单漏一个成员的后果是"付了钱的合法响应被判非法"，
 * 而这种漏配没有任何运行时信号，只有付费之后才炸。
 */
type _ModuleIdsCoverModuleId = Exclude<ModuleId, (typeof MODULE_IDS)[number]> extends never
  ? true
  : never;

/**
 * 运行时判定一个字符串是不是已上线的 Module ID。
 *
 * 给**环境变量 / 外部输入**用：这些值会被拼进 `POST /modules/:id/check` 的 URL，
 * 而那是一个会真的花钱的端点。
 */
export function isModuleId(value: string): value is ModuleId;
```

`packages/chain/src/index.ts`：`export { assertModuleResponse, isModuleId, MODULE_IDS }`。

> `assertModuleResponse` / `readEnum` 的签名与逻辑**一律不动**：它们已经消费
> `MODULE_IDS`，扩容自动生效。

### 3.2 `@citely/server`（法域表 + 配置校验）

`packages/server/src/constants.ts`：

```ts
export const MODULE_JURISDICTIONS: Record<ModuleId, string> = {
  "us-msb": "United States",
  "uk-msb": "United Kingdom",
  "eu-msb": "European Union",
  "sg-msb": "Singapore",
  "ae-msb": "United Arab Emirates",
};
```

`packages/server/src/config.ts`（**可选项，见 §5.2，建议做**）：

```ts
// ServerConfig 字段类型收窄
readonly moduleId: ModuleId;   // 原为 string

// loadServerConfig 内，与其他项一样进 IssueCollector（一次报全，不逐个抛）
const moduleId = issues.capture(MODULE_ID_ENV, () => readModuleId(env));

/**
 * 读取并校验 `MODULE_ID`。未设置时回落 `us-msb`（与现状一致）。
 * 报错消息里列出合法取值——运维打错一个字母时，能一眼看出打错在哪。
 */
function readModuleId(env: EnvSource): ModuleId;
```

`packages/server/src/index.ts:193`：`moduleId: config.moduleId`（删掉 `as ModuleId`），
文件顶部 `import type { ModuleId }` 若因此变成未使用则一并删。

### 3.3 `@citely/verifier`（认证清单，**运维动作，非代码改动**）

无源码改动。资产需要重新生成：

```bash
pnpm -F @citely/verifier snapshot:modules        # 联网、免费 GET，重写 modules.source.json + rules/*.json
MODULE_ATTESTER_PRIVATE_KEY=0x… pnpm -F @citely/verifier sign:attestations   # 离线签名，重写 modules.json
```

产出：`packages/verifier/attestations/rules/ae-msb@2026.08.1.json` 新增，
`modules.source.json` / `modules.json` 从 4 条变 5 条。

⚠️ 两个约束（人必须知道）：
1. 签名密钥必须仍是 `attestations-assets.test.ts:25` 钉死的
   `0x1423BDE806123132ec1422f8B9FF517e75ff8e92`，换钥匙 = 改信任根 = 另一件事；
2. `snapshot:modules` 是**全量重抓**：如果上游这段时间 bump 过 `us/uk/eu/sg` 的
   版本号，本次会连带更新——必须逐条 `git diff` 确认变更是预期的，
   不能囫囵提交（版本号变了而认证没重签，检查②会在演示现场炸）。

**若拿不到认证密钥**：跳过本节。后果是确定且 fail-closed 的——`ae-msb` 案件的 SA
在验证器检查②失败（`attestation_missing: ae-msb@2026.08.1`），案件走 reject 路径
（escrow 退回 client），**不会误放行**。这是可接受的中间态，但"MODULE_ID=ae-msb
能跑完整案件"这条验收就不成立，须如实标注。

### 3.4 不需要动的地方（已逐个核查）

| 位置 | 为什么不动 |
|---|---|
| `packages/server/src/webapp/app.js:476` | 模块表格从 agent card 的 `x-citely.modules` 动态渲染，加一行自动出现 |
| `packages/server/src/agent-card.ts:141` | `Object.entries(MODULE_JURISDICTIONS)` 动态遍历（只有第 138 行注释里"四个可用 module"要改字） |
| `packages/engine/**` | 全部经 `ModuleId` 类型透传（`orchestrator/types.ts:137`、`purchase-store.ts:146`），无字面量白名单 |
| `packages/engine/src/routing/procurement.ts` | 白名单是**端点 URL** 白名单，不是模块 id 白名单；且当前未接进 `runCase`（见 §7.1） |
| `packages/marketplace/src/policy.ts:132` | `requiredModuleRefs` 生产/demo 均为 `[]`，不构成阻断 |
| `demo/fixtures/recorded/us-msb.json`、`demo/scripts/record-module-response.ts:38` | 主线 demo 的真实录制，刻意只录 us-msb；录 ae-msb 要真花 1.00 USDC，不在本次范围 |
| `rubrics/us-msb.json`、`packages/engine/src/rubric/**`、golden 缓存 | rubric 与 `MODULE_ID` 无耦合（见 §7.2） |
| `packages/verifier/src/testing/sa-fixture.ts`、各 `*.test.ts` 里的 `us-msb` 字面量 | 都是测试数据，不是白名单；改了只会制造无谓 diff |

---

## 4. 数据结构 / schema 变更

- **SA schema：不变。** `modules_used[]` 本来就是 `{module_id, version, evidence_hash}`
  的开放字符串三元组，`sa/hash.ts` 的预映射不含模块枚举，历史 SA 哈希不受影响；
- **模块响应 schema：不变。** 只是 `module` 字段的合法取值集合多一个成员；
- **认证清单：`manifest_version` 保持 `"1"`。** 被签字段集（`moduleId/version/rulesHash`）
  未变，只是条目多一条——按 `attestation-source.ts:30` 的规则，只有"改动被签字段集"
  才递增；
- **上游模块 version：不 bump。** 我们不改任何规则文件；`ae-msb@2026.08.1` 是上游
  已发布的版本，Deal Desk 侧只是消费方。**`evidence_hash` 定义一个字都不动。**
- Deal Desk 自身无"模块版本号"概念，故本次**无版本号 bump 项**。CHANGELOG 记一条即可。

---

## 5. 安全考量

### 5.1 输入校验

- `assertModuleResponse` 是"**付了钱才拿到的响应**"的信任边界。扩容 `MODULE_IDS`
  是把一个新身份加进白名单，**不放松任何既有约束**：`readEnum` 仍逐字匹配，
  `x402-client.ts:335` 的 `assertMatchesRequest` 仍强制 `response.module === 请求的 moduleId`
  ——上游返错模块的响应照样炸；
- `deal-input.ts` 的国别校验是 ISO 3166-1 alpha-2 正则，`AE` 本就合法，无需改动；
- **没有也不新增"法域守卫"**：Deal Desk 不校验 `MODULE_ID` 与 `parties[].country`
  是否匹配（既有行为，见 `docs/design/upstream-msb-api-breaking-change-2026-07-31.md:103`）。
  这次不顺手加——那是判定语义变更，要单独设计。

### 5.2 支付路径（这是把硬 cast 改掉的真正理由）

`config.moduleId` 目前是**未经校验的环境变量字符串**，在 `index.ts:193` 被 cast 成
`ModuleId`，随后在 `x402-client.ts:356` 被拼进
`${baseUrl}/modules/${moduleId}/check` 并发起**付费**请求。当前风险有限
（`baseUrl` 独立配置，路径段污染最多打到 msb-agent 自己的 404，且 402 报价签名由
Gateway 校验），但这是整条链路上唯一"字符串裸奔进付款 URL"的地方，且
fail-fast 的成本是 10 行。

**建议（标注为可选项，主导可否决）**：在 `config.ts` 用 `isModuleId` 校验，
让错拼的 `MODULE_ID` 在**启动时**和其他配置问题一起报出来，而不是在第一次真实
案件、付款那一刻才 404。放在 `config.ts` 而不是 `index.ts`，是为了复用
`IssueCollector` 的"一次报全"（`config.ts:93` 的既有纪律：Railway 上逐个报错 = 逐个部署）。

### 5.3 密钥处理

- 本次代码改动**不接触任何密钥**；
- `MODULE_ATTESTER_PRIVATE_KEY` 只由 `packages/verifier/scripts/sign-attestations.ts`
  离线读取，刻意放在 `scripts/` 而非 `src/`（`key-source.test.ts` 的静态扫描会拦
  运行时源码里出现的密钥变量名）——本次不改这条纪律，也**不得**把该变量配到 Railway；
- 认证签名产物 `modules.json` 入库，但只含地址与签名，`attestations-assets.test.ts:45`
  已有"入库资产里没有私钥形状串"的断言，新增条目自动被覆盖。

### 5.4 架构不变量核对

| 不变量 | 是否受影响 | 理由 |
|---|---|---|
| LLM 无权改判定 | 否 | 本次只动 id 枚举与法域文案，判定仍由上游规则引擎 + Policy Engine 从 `settlement_constraints` 推导；判定器（LLM）只产 basis/confidence |
| 零自定义合约 | 否 | 不碰 ERC-8183 / ERC-8004 / USDC 任何合约调用 |
| 材料是数据不是指令（沙箱） | 否 | intake 路径未改 |
| `NOT_APPLICABLE` 不等于放行 | 否 | 放行判据仍看 `evaluated_check_count` + 两个阻断列表，本次一行未动 |
| 对外输出是检查项状态、不是法律意见 | 否 | `DISCLAIMER` 逐字不变；新增的只有一行法域文案 |
| 验证器与签名者是两把钥 | 否 | 认证密钥仍是第三把、仍离线 |

---

## 6. 实现步骤清单（供 Codex 逐条执行）

> 每条都可独立验证。包边界已在每条前标注。
> **P1 = 本次必做；P2 = 可选项（§5.2），主导拍板后再做；P3 = 运维动作（需密钥）**

### chain 包

- [ ] **P1-1** `packages/chain/src/types/module.ts:11`：`ModuleId` 联合类型加 `"ae-msb"`，
      注释更新为 5 个法域并注明 ae-msb 于 2026-08 上线。
      验证：`pnpm -F @citely/chain typecheck` 通过。
- [ ] **P1-2** `packages/chain/src/validate/module-response.ts:14`：`MODULE_IDS` 加 `"ae-msb"`，
      并把类型注解改为 `as const satisfies readonly ModuleId[]`。
      验证：`pnpm -F @citely/chain typecheck` 通过。
- [ ] **P1-3** 同文件紧随其后加编译期穷尽性检查 `type _ModuleIdsCoverModuleId = ...`（见 §3.1），
      带注释说明它为什么存在。
      验证：临时从 `MODULE_IDS` 删掉任一成员 → typecheck 报错；恢复后通过（验证完必须恢复）。
- [ ] **P1-4** 同文件导出 `isModuleId(value: string): value is ModuleId`（实现基于 `MODULE_IDS`），
      并在 `packages/chain/src/index.ts:104` 一行里一并导出。
      验证：新增单测（P1-11）通过。
- [ ] **P1-5** `packages/chain/src/x402-client.ts:26`：修正过时注释——
      "最贵的 us-msb 单次 0.80 USDC" 已不成立（现最贵是 ae-msb 1.00 USDC）。
      `MINIMUM_GATEWAY_BALANCE` 的**数值保持 `1_050_000n` 不变**（仍 ≥ 最贵单价），
      但注释里写清"1.00 的单价只剩 0.05 余量，连跑两案需可用余额 ≥ 2.05"。
      验证：`git diff` 只有注释变化，`pnpm -F @citely/chain test` 全绿。

### server 包

- [ ] **P1-6** `packages/server/src/constants.ts:58-62`：`MODULE_JURISDICTIONS` 加
      `"ae-msb": "United Arab Emirates"`；上方注释里的"这四个 module"改成"这五个 module"。
      验证：typecheck 通过（不加会因 `Record<ModuleId,string>` 直接报错）。
- [ ] **P1-7** `packages/server/src/agent-card.ts:138` 注释"四个可用 module"→"五个可用 module"。
      验证：`git diff` 仅注释。

### 测试（随代码一起改，不单独排期）

- [ ] **P1-8** `packages/chain/src/validate/module-response.test.ts:180-181`：
      断言改为 `["us-msb","uk-msb","eu-msb","sg-msb","ae-msb"]`，用例名同步改"五个"。
- [ ] **P1-9** `packages/server/src/constants.test.ts:13-18`：期望键数组补 `"ae-msb"`（注意该断言是 `.sort()` 后比较，`ae-msb` 排最前）。
- [ ] **P1-10** `packages/server/src/agent-card.test.ts:70-79`：用例名与期望数组补 `"ae-msb"`。
- [ ] **P1-11** `packages/chain/src/validate/module-response.test.ts` 新增两条：
      ① `assertModuleResponse` 接受 `module: "ae-msb"` + `settlement_constraints.module: "ae-msb"`
      的完整响应并原样收窄；② `isModuleId("ae-msb") === true`、
      `isModuleId("ae-msb ") === false`、`isModuleId("xx-msb") === false`。
- [ ] **P1-12** `packages/chain/src/x402-client.test.ts` 新增**端到端到校验层**用例：
      用既有 stub `GatewayLike` 返回一份 `ae-msb` 形状的 200 响应
      （`module: "ae-msb"`、`version: "2026.08.1"`、`checks[].id` 用真实规则 id 如
      `ae-cbuae-rps-license`、`basis`/`evaluated_check_count` 齐全），
      断言：`client.check("ae-msb", DEAL_INPUT)` 请求 URL 为
      `${BASE_URL}/modules/ae-msb/check`、返回值通过 `assertModuleResponse` 且
      `assertMatchesRequest` 不抛、`settlementId`/`paidAtomic` 透出正确。
      验证：`pnpm -F @citely/chain test` 全绿；这条即"MODULE_ID=ae-msb 的案件流程走到校验层不抛错"。

### server 包 · 可选项（fail-fast 启动校验）

- [ ] **P2-1** `packages/server/src/config.ts`：新增 `readModuleId(env): ModuleId`（用
      `isModuleId`，非法值抛错、消息里列出合法取值且**不回显**多余上下文），
      在 `loadServerConfig` 内用 `issues.capture(MODULE_ID_ENV, ...)` 调用，
      未设置时仍回落 `us-msb`；`ServerConfig.moduleId` 类型由 `string` 收窄为 `ModuleId`。
- [ ] **P2-2** `packages/server/src/index.ts:193`：删掉 `as ModuleId`，
      若 `import type { ModuleId }` 因此未被使用则一并删除。
      验证：`pnpm -F @citely/server typecheck` 通过。
- [ ] **P2-3** `packages/server/src/config.test.ts`：新增三条——
      `MODULE_ID` 缺省 → `us-msb`；`MODULE_ID=ae-msb` → `config.moduleId === "ae-msb"`；
      `MODULE_ID=xx-msb` → 抛 `ServerConfigError` 且 `issues` 里含 `MODULE_ID` 一项
      （用既有"一次报全"的断言写法）。

### 运维资产（P3，需 `MODULE_ATTESTER_PRIVATE_KEY`，**由人执行，不给 Codex**）

- [ ] **P3-1** 跑 `pnpm -F @citely/verifier snapshot:modules`，逐条 `git diff` 确认：
      新增 `attestations/rules/ae-msb@2026.08.1.json`、`modules.source.json` 变 5 条；
      **若 us/uk/eu/sg 的版本号同时发生变化，先停下来评估**（版本漂移要单独确认）。
- [ ] **P3-2** 跑 `MODULE_ATTESTER_PRIVATE_KEY=0x… pnpm -F @citely/verifier sign:attestations`，
      核对脚本打印的派生地址仍为 `0x1423BDE806123132ec1422f8B9FF517e75ff8e92`。
- [ ] **P3-3** 跑 `pnpm -F @citely/verifier test`：`attestations-assets.test.ts` 会对新条目自动
      逐项验签、复算 `rules_hash`、比对快照版本号——全绿即认证资产自洽。

### 文档（与代码同一次提交）

- [ ] **D-1** `README.md:131` / `README.zh-CN.md:122-123`：把"Deal Desk 当前接入前四个模块"
      改成"五个模块全部接入"，并如实标注 ae-msb 单价 1.00 USDC。
- [ ] **D-2** `.env.example:104-109`：`MODULE_ID` 注释补充合法取值
      （`us-msb|uk-msb|eu-msb|sg-msb|ae-msb`）；顺带修正 `MODULE_PRICE_USDC` /
      `CASE_BUDGET_USDC` 的描述——现注释写成"采购上限/采购预算上限"，
      与代码语义不符（前者是进账本 `amount_nominal` 的报价，后者是 ERC-8183 escrow 案件费）。
      **只改文字，不改语义。**
- [ ] **D-3** `docs/deploy-railway-vars.md`：`MODULE_ID` 一行补 ae-msb 可选值说明；
      若跑 ae-msb，`MODULE_PRICE_USDC` 须配 `1.00`（配错只影响账本 `amount_nominal`，
      实付仍按 Gateway 真实扣款记，但对账会难看）。
- [ ] **D-4** `CHANGELOG`：记一条"接入上游 ae-msb（第 5 法域）"，引用本设计文档路径；
      写明未做 UAE rubric、以及未签认证时的 fail-closed 行为。

---

## 7. 两个风险点的核查结论

### 7.1 预算：3.00 USDC 够不够跑完一个 ae-msb 案件？—— **够，且根本不在同一个池子**

核查过程与结论：

1. `CASE_BUDGET_USDC=3.00`（`config.ts:321`）是 **ERC-8183 escrow 案件费**，
   即客户付给 Deal Desk 的服务费，由 `case-runner.ts:83` 传成 `job.budgetAtomic`，
   在 `run-case.ts:272` 与链上 Job 逐字比对（`budget_mismatch`）。
   它**不是**模块采购的预算池；
2. 模块采购的钱来自 **procurement 钱包在 Circle Gateway 的可用余额**
   （`x402-client.ts:357`），与 escrow 完全独立。`MODULE_PRICE_USDC` 只进账本
   `amount_nominal`（`run-case.ts:360`），实付一律取 Gateway 返回的真实扣款
   （`stages.ts:275` / `purchase.ts:88` 都有逐字纪律）；
3. `checkProcurement`（采购三约束，含 `exceeds_case_budget`）**当前未接进 `runCase`**
   ——全仓只有 `scripts/spike/exit3-procurement.ts` 与 `routing.test.ts` 调它。
   所以 1.00 USDC 的 ae-msb **不会**触发任何案件预算拒绝；
4. 真正会拦的是 `MINIMUM_GATEWAY_BALANCE = 1_050_000n`（`x402-client.ts:28`）：
   每次 `check` 前要求可用余额 ≥ 1.05 USDC。ae-msb 单价 1.00 → 一次采购后余额
   净减 1.00，**若起始余额低于 2.05，第二次案件就会以"采购钱包 Gateway 可用余额不足"
   响亮失败**（不是静默降级，行为可接受但演示会中断）。

**结论：无需改代码。运维前置条件：跑 ae-msb 演示前确认 procurement 钱包 Gateway
可用余额 ≥ 2.05 USDC（每多一个案件 +1.00）。** 顺带修 `x402-client.ts:26`
那句已过时的注释（P1-5）。是否把余额门槛从 1.05 抬高到 2.05 属判断题——
抬高会让 1.05~2.05 之间**本可成功**的单次采购被拒，我倾向不抬，留给主导拍板。

### 7.2 rubric：没有 `rubrics/ae-msb.json` 会怎样？—— **不会崩，会 fail-closed 地升级到人工**

核查过程与结论：

1. `rubrics/` 下**只有** `us-msb.json`（+ README）。rubric 由 `RUBRIC_PATH` 独立配置
   （`config.ts:327`、`index.ts:157`），与 `MODULE_ID` **没有任何一致性校验**
   ——全仓 grep 不到把 `rubric.id` 与 `moduleId` 比对的代码；
2. 因此 `MODULE_ID=ae-msb` + `RUBRIC_PATH=rubrics/us-msb.json` 可以正常启动、
   正常采购、正常出 SA：rubric 只喂**判定器**（LLM system prompt 的唯一内容来源），
   而模块检查项来自上游响应，两条链路在 `buildSettlementLegs` 才汇合；
3. 语义后果（如实写清，不美化）：判定器会被问一组 **US 口径**的 item
   （FinCEN 注册、州级 MT 牌照等），面对一笔 UAE 交易，材料里没有对应事实，
   多半落 `gray_data` / `unverifiable` → `routeExit` 路由到**出口 4（升级/人工）**，
   legs 落 HOLD/ESCALATE。**不会误放行**，也不会抛异常；
4. golden 缓存键含 `rubric_item_sha256`，沿用 us-msb rubric 意味着缓存仍命中同一批
   item，不会因为换模块而失效。

**结论：本次不写 UAE rubric（缺它不崩，且写 rubric 是 L1 知识资产工作，
范围与审查标准都不同）。** 但必须在 README/CHANGELOG 里如实标注：
"ae-msb 案件当前复用 us-msb rubric，判定器口径与法域不匹配，预期结果偏向
HOLD/ESCALATE"——不标注就等于让人以为我们有 UAE 判定能力。
是否要补 `rubrics/ae-msb.json` 是**独立任务**，留给主导排期。

### 7.3 额外发现的硬编码点（超出主导给的三处）

| 位置 | 性质 | 本次是否要改 |
|---|---|---|
| `packages/verifier/attestations/modules.json` / `modules.source.json` / `rules/*.json` | **真正的功能性阻断**：SA 引用未认证的 `ae-msb@2026.08.1` → 检查② `attestation_missing` → 案件 reject | **要**（P3，需认证密钥；拿不到就接受 fail-closed 中间态） |
| `packages/server/src/constants.test.ts:13-18` | 对 `MODULE_JURISDICTIONS` 键集的**全量断言** | 要（P1-9） |
| `packages/server/src/agent-card.test.ts:70-79` | 对 card 里 module 列表的**全量断言** | 要（P1-10） |
| `packages/chain/src/validate/module-response.test.ts:180-181` | 对 `MODULE_IDS` 的**全量断言** | 要（P1-8） |
| `packages/chain/src/x402-client.ts:26` 注释 | 事实性错误（"最贵的 us-msb 0.80"） | 要（P1-5） |
| `packages/server/src/agent-card.ts:138` 注释"四个可用 module" | 文案 | 要（P1-7） |
| `README.md:131` / `README.zh-CN.md:122` "当前接入前四个模块" | 对外承诺文案 | 要（D-1） |
| `.env.example:104-109` | `MODULE_ID` 取值未列全 + 两条描述与代码语义不符 | 要（D-2） |
| `demo/scripts/record-module-response.ts:38`（`MODULE_ID = "us-msb"`） | 真实付费录制脚本，刻意锁 us-msb | **不改**（录 ae-msb 要真花 1.00 USDC，且 fixture 消费方是 us-msb 主线 demo） |
| `demo/run-vertical-slice.ts:90`（`MODULE_ID: ModuleId = "us-msb"`） | 纵切演示脚本 | 不改（主线 demo 就是 us-msb） |
| `packages/engine/scripts/golden.ts:57`、`injection-live-check.ts:186`、`rubric.test.ts:8`、`injection.test.ts:42`、`sign-verify.integration.test.ts:52` | 硬编码 `rubrics/us-msb.json` 路径 | 不改（唯一存在的 rubric，见 §7.2） |
| 各包测试里大量 `"us-msb"` 字面量（policy/ledger/purchase-store/sa/marketplace/verifier…） | 测试数据 | 不改 |
| `packages/marketplace/src/policy.test.ts:43` `requiredModuleRefs: ["us-msb@2026.07.1"]` | 测试数据；生产与 demo 均为 `[]` | 不改 |
| `demo/fixtures/recorded/us-msb*.json`、`demo/golden/**` | 录制快照与 golden 缓存 | 不改（golden 键含 rubric 哈希，与模块 id 无关） |
| `docs/design/*.md` 历史文档里的"四模块" | 历史记录 | 不改（历史文档不追改，本文件即新事实源） |

---

## 8. 测试要求（QA 据此验收）

### 8.1 必过项

| # | 检查 | 命令 / 判据 |
|---|---|---|
| T1 | 全仓类型检查 | `pnpm typecheck` 零错误 |
| T2 | 全仓测试 | `pnpm test` 全绿（`pnpm -r --no-bail test`） |
| T3 | Lint | `pnpm lint` 零错误 |
| T4 | 穷尽性保护有效 | 手工从 `MODULE_IDS` 删一个成员 → `pnpm -F @citely/chain typecheck` **必须报错**；恢复后通过 |
| T5 | 白名单双向 | `assertModuleResponse` 接受 `module: "ae-msb"`；拒绝 `module: "za-msb"` 并在错误消息里点名字段与合法取值 |
| T6 | **端到端（到校验层）** | P1-12 那条：stub Gateway → `client.check("ae-msb", deal)` → URL 为 `/modules/ae-msb/check`、响应过 `assertModuleResponse` + `assertMatchesRequest`、`settlementId`/`paidAtomic` 正确透出，**全程零异常** |
| T7 | agent card | 渲染出 5 条 module，`ae-msb` 的 `jurisdiction` 为 `United Arab Emirates`、`sourced_from` 指向 msb-agent |
| T8 | 不变量未被削弱 | `NOT_APPLICABLE` / `evaluated_check_count` 相关既有用例一条未改（`git diff` 可核）；`DISCLAIMER` 逐字未变 |

### 8.2 做了 P2 才验

| # | 检查 | 判据 |
|---|---|---|
| T9 | `MODULE_ID` fail-fast | `MODULE_ID=xx-msb` → `loadServerConfig` 抛 `ServerConfigError`，`issues` 含 `MODULE_ID`，消息**不含**其他环境变量的值 |
| T10 | 默认值不变 | 不设 `MODULE_ID` → `config.moduleId === "us-msb"` |
| T11 | 一次报全未被破坏 | 同时缺多个变量时，`MODULE_ID` 的问题与其他问题**一起**报出（不是提前抛断） |

### 8.3 做了 P3 才验（运维）

| # | 检查 | 判据 |
|---|---|---|
| T12 | 认证资产自洽 | `pnpm -F @citely/verifier test` 全绿；`modules.json` 5 条、每条验签通过、`rules_hash` 可从随包快照复算 |
| T13 | 认证方未变 | 新条目的 `attester` 仍为 `0x1423BDE806123132ec1422f8B9FF517e75ff8e92` |
| T14 | 无版本漂移 | `git diff packages/verifier/attestations/` 中，us/uk/eu/sg 四条的 `version` 与 `rules_hash` **未变**（变了要单独说明原因） |

### 8.4 人工冒烟（不进 CI，花不花钱已标注）

- **S1（免费）**：`curl -s https://msb-agent-production-769d.up.railway.app/modules | jq '.modules[] | {module, version, price}'`
  → 确认 `ae-msb` 存在、`version` 为 `2026.08.1`、价格 `1.000000`。
  若线上版本号与 P3-1 快照不一致，**停下来**，认证会验不过；
- **S2（花 1.00 USDC，且依赖 P3 已完成）**：`MODULE_ID=ae-msb MODULE_PRICE_USDC=1.00`
  起服务，跑一个 payee 在 AE 的案件，期望：采购成功 → 检查②通过 → 出 SA →
  判定多为 HOLD/ESCALATE（rubric 口径不匹配，见 §7.2）。
  **前置**：procurement 钱包 Gateway 可用余额 ≥ 2.05 USDC。

---

## 9. 执行模式判断

**确认主导判断：单 implementer 即可。**

依据：
- P1 全部改动集中在 5 个源文件 + 4 个测试文件，净增不到 60 行，且被同一条编译期
  穷尽性检查串起来——拆给多人反而要处理 `ModuleId` 类型跨包的中间态编译失败；
- P2 与 P1 有顺序依赖（`isModuleId` 先落地），P3 是人工运维动作、Codex 不该碰密钥；
- 执行顺序建议：**P1 一次性做完并过双审查 → 主导拍板 P2 是否做 → P3 由人执行**。
  P3 不阻塞 P1 提交（未签认证只影响 ae-msb 案件能否验证通过，不影响既有 4 模块）。

---

## 10. 核心结论摘要

1. **方案定为"枚举扩容 + 编译期穷尽性检查"（A′）**：`ModuleId` 与 `MODULE_IDS`
   各加一个 `"ae-msb"`，另加 8 行类型代码，让"两处漏改一处"从此变成编译错误。
   否决了"白名单改运行时环境变量"（降安全等级、URL 拼接直连付费端点）和
   "引入 zod"（破坏 chain 包刻意维持的零 zod 依赖白名单）。
2. **除主导给的三处外，还有 9 处需要动**：三条全量断言测试
   （`constants.test.ts` / `agent-card.test.ts` / `module-response.test.ts`）、
   两处注释事实错误（`x402-client.ts:26` 的"最贵 0.80"、`agent-card.ts:138` 的"四个"）、
   README 中英双份的"当前接入前四个模块"、`.env.example` 的取值列表与两条描述错误，
   以及 **`packages/verifier/attestations/` 认证清单**。
3. **最重要的额外发现：验证器的 Module 版本认证清单是功能性阻断。**
   `ae-msb@2026.08.1` 不在 `attestations/modules.json` 里，SA 会在检查②
   `attestation_missing` 失败、案件走 reject（escrow 退回）。
   补它需要 `MODULE_ATTESTER_PRIVATE_KEY`（离线、不入库、地址必须仍是 `0x1423…`）。
   **拿不到密钥也可以先合并 P1**——行为是 fail-closed 的，不会误放行，
   但"MODULE_ID=ae-msb 跑通完整案件"这条验收就不成立。**这条要人拍板。**
4. **预算风险核查结论：不是问题，但有运维前置条件。** `CASE_BUDGET_USDC=3.00` 是
   ERC-8183 escrow 案件费，与模块采购**不同池子**；`checkProcurement` 的案件预算约束
   当前根本没接进 `runCase`。真正会拦的是 `MINIMUM_GATEWAY_BALANCE=1.05`：
   ae-msb 单价 1.00，**procurement 钱包 Gateway 可用余额需 ≥ 2.05 才能连跑两案**。
   是否把这个门槛抬高，**留给人拍板**（抬高会误拒本可成功的单次采购）。
5. **rubric 风险核查结论：缺 `rubrics/ae-msb.json` 不会崩。** rubric 与 `MODULE_ID`
   零耦合、零一致性校验；沿用 us-msb rubric 的后果是判定器被问 US 口径 item →
   多落 gray → 路由到出口 4（人工升级），**不会误放行**。本次不写 UAE rubric，
   但**必须在文档里如实标注这个口径错配**，否则等于对外宣称有 UAE 判定能力。
   是否补 rubric 是独立任务，**留给人排期**。
6. **架构不变量全部不受影响**：判定回路无 LLM（本次只动 id 枚举与文案）、
   零自定义合约、`NOT_APPLICABLE`/`evaluated_check_count` 放行判据一行未动、
   `evidence_hash` 与 SA schema 定义不变、免责声明逐字不变。
7. **无版本号 bump**：不改任何上游规则文件，Deal Desk 自身无模块版本号概念；
   认证清单 `manifest_version` 保持 `"1"`（被签字段集未变）。
8. **可选项（建议做，但可否决）**：把 `index.ts` 的 `config.moduleId as ModuleId`
   硬 cast 换成 `config.ts` 里的 `isModuleId` 启动校验。理由不是整洁，是那个
   未校验字符串会被拼进**会花钱的** URL；放在 `config.ts` 是为了复用"配置问题一次报全"。
9. **执行模式：单 implementer，P1 → 拍板 P2 → 人工做 P3**，P3 不阻塞 P1 提交。
10. **验收的核心一条**：stub Gateway 下 `client.check("ae-msb", deal)` 打到
    `/modules/ae-msb/check`、响应过 `assertModuleResponse` + `assertMatchesRequest`
    全程零异常（T6）；线上真实冒烟 S2 花 1.00 USDC 且依赖 P3，单独安排。
