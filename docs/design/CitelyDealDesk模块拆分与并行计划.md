# Citely Deal Desk 模块拆分与并行实施计划

**版本**：v1.1（2026-07-28）　**配套**：《CitelyDealDesk技术实现方案》v2.2
**原则**：契约先行（contract-first）——先冻结模块间数据契约，每个模块对着契约和 fixture 独立开发、独立测试、独立提交；集成只发生在三个预定的里程碑上。每个模块的定义都满足"可独立验证、低耦合、单模块工作量不超过一次交付循环"——**可直接映射为 agent 流水线的设计文档单元**（architect 出设计 → 执行器实现 → QA/安全审查，模块即任务边界）。

---

## 一、先冻结的六个数据契约（D1–2，与 spike 并行）

契约是并行的前提——冻结后任何修改需双人确认并广播。

| # | 契约 | 内容 | 状态 |
|---|---|---|---|
| C1 | **Deal Schema** | 案件订单输入：参与方（角色/法域/钱包/KYB材料引用）、资金流描述、金额（名义/实测） | 待定义（唯一新契约，D1 首要任务） |
| C2 | **Module Check API** | `GET /check/{module_id}` 的 402 信封 + 响应体 `{check_result, module_version, evidence_hash, maintainer_wallet}` | 技术方案 §2.1b 已有骨架，补字段定版 |
| C3 | **SA Schema** | Settlement Authorization 全结构 | §4.2 已定版 ✓ |
| C4 | **Ledger Row** | `{direction, amount_nominal, amount_actual, ref, ref_type: jobId|gateway_receipt|txHash, category}`——nanopayment 类目挂 Gateway 回执，批量结算后补挂结算 tx | 按 Gateway 批量结算机制修订 |
| C5 | **Rubric Schema** | 判定项结构 | §4.1 已定版 ✓ |
| C6 | **chain-kit TS 接口** | `JobClient`（create/fund/submit/complete/reject/poll）、`WalletKit`（transfer/signTypedData）、`X402Client`（payAndFetch）——上层只依赖接口，不依赖实现 | D1 定义，随 spike 实现 |

## 二、九个模块（状态更新：2026-07-28）

| 模块 | 内容 | 状态 | 备注 |
|---|---|---|---|
| **M1 chain-kit** | 8183 封装、Circle Wallets、x402 买方、Gateway 余额管理、轮询器 | 🟡 **部分完成** | x402 买方路径已由 msb-agent 的 smoke 脚本验证（`@circle-fin/x402-batching` 的 `GatewayClient.pay()`，含 Gateway 自动入金）；**8183 案件 Job 封装与轮询器未见交付，是 M3/M6 的前置缺口** |
| **M2 module-server** | x402 卖家服务：四法域确定性检查 | ✅ **完成并超额**（repo: web3yaso/msb-agent） | Live 于 Railway；四模块 us/uk/**eu**/sg（EU 替代原计划 DE）；真实 402 流 + GatewayWalletBatched 结算；`evidence_hash` 可离线重放；`settlement_constraints` 即 SA 的机器接口；**ERC-8004 已注册（Agent ID 851930，链上 tx 可查）**；Marketplace 申请 7/27 已提交待审 |
| **M3 engine-core** | 案件状态机 + Policy Engine（Module结果→SA）+ 五出口路由 | 🔴 **未确认 / 关键路径** | M2 live 后其输入侧已就绪：`GatewayClient.pay()` 三行即可调真模块。**当前最高优先级** |
| **M4 llm-orchestrator** | 订单解析、卷宗起草、注入防御 | 🔴 未确认 | 可与 M3 合并交付最小版（解析+卷宗模板化，砍掉自由起草） |
| **M5 verifier** | SA 三检 → complete/reject | ⚪ **可降级** | `evidence_hash` 离线重放已承担验证叙事——时间不够则降级为脚本演示重放，不接链 |
| **M6 marketplace-agent** | 发单注资、读 SA、执行分账/hold、注资 Review Job | 🔴 **未确认 / 关键路径第二位** | 依赖 M1 的 8183 封装 |
| **M7 dashboard** | 四区单页 | ⚪ 可降级 | 底线为终端输出 + 账本表打印；若做，数字全部从配置 JSON 读（见下方 P&L 结构先行原则） |
| **M8 knowledge** | 四法域规则文件 + Module 配置 | 🟡 **大部完成** | 已随 M2 交付（版本化、带法源引用）；US MSB 深度对照 D3 工单的差距未审计——提交前抽查六项豁免覆盖 |
| **M9 demo-assets** | 合成案件、注入样例、golden outputs、彩排脚本 | 🔴 未开始 | D18 前必须完成，含备份录屏 |

**P&L 结构先行原则（数字最后定）**：P&L 页与账本渲染按五段结构搭（收入/代管/支出/释放/退款，每行挂回执位）；模块价格、预算、比例尺全部从单一配置 JSON 读取——最终数字在 D18 冻结前改配置即全站生效，不碰代码。方案 A（按需调用 + 采购实报实销 + fee 即毛利）为候选口径，待定稿。

**版税行前提**：`maintainer_wallet` 零地址 = 无版税（api.md 已声明该参数不被 evidence_hash 背书）。demo 保留版税一拍则需配置真实 maintainer 钱包 + royalty_bps（约 10 分钟配置活）；不配置则从 P&L 与 demo 诚实删除该拍。

## 三、最后冲刺计划（7/28 → 8/1，替代原泳道图）

```
7/28  M3 最小链路：案件分解 → GatewayClient.pay() 调真实 us-msb
      → 拿回 PASS/HOLD/ESCALATE → Policy Engine 汇总 SA JSON
      （M4 以模板化最小版并入；不做自由起草）
7/29  M1 补 8183 案件 Job 封装 → M6：发单注资 → 读 SA → 分账/hold 执行
      ＋ maintainer 钱包配置决策（版税拍去留）
7/30  【I3】全流程冷启动串通 ×2 → 修复 → M9：合成案件定稿 + golden outputs
      → 备份录屏（M3′ 里程碑：账本页与视频冻结）
7/31  数字定稿（改配置 JSON）→ 彩排 ×2 → README/提交材料/架构图导出
8/1   提交（整天缓冲：testnet 故障、表单、补录）
```

**冲刺纪律**：M5/M7 不阻塞主线——M5 用 evidence_hash 离线重放脚本替代、M7 底线为终端输出；每天结束时必须有一段可播放的录屏增量（哪怕只有当天新通的那一段）；任何组件当天不通即触发对应降级，不过夜。

## 四、与 agent 流水线的映射（同步实现的执行方式）

每个模块 = 一份设计文档 = 一条流水线任务，按既有 agent 集群规范执行：

0. **流水线装备（D1）**：所有 worktree/teammate 统一安装 Circle Skills 插件 + 接入 Circle MCP Server（`claude mcp add --transport http circle https://api.circle.com/v1/codegen/mcp --scope user`）——执行 agent 获得 Circle 官方维护的实时 SDK 签名与稳定模式，M1 的外部依赖风险由此对冲
1. **设计文档**：每模块一份 `docs/design/M{n}-{name}.md`，内容 = 本文对应行展开 + 契约引用 + 实现步骤清单（勾选框，每步可独立验证）。M3 的清单按五出口逐出口拆步
2. **执行**：无依赖模块（M2 free-mode、M3 fake链、M7 fixture、M8）可各开一个 worktree/teammate 并行跑"实现→QA→安全→提交"循环；M1 因依赖外部服务的不确定性建议人工主导+agent 辅助
3. **审查重点定制**：M3 的 QA 清单加"幂等与状态表完整性"；M2/M4 的安全清单加"注入用例回归"；M1 的安全清单加"密钥不入库"
4. **集成日专用**：I1/I2/I3 三天不派新任务，只做联调与修复——集成失败的修复任务回到对应模块的流水线

## 五、双人分工建议

- **Sophie**：C1/C6 定义、M1、M3（关键路径）、M5、I1–I3 集成主导
- **Alex**：M8 全部（US MSB rubric 按 D3 工单产出后由 Sophie 转 JSON）、M2 的 Module 配置内容、M9 的案情文案与 SA 措辞审查（含"不写 Citely authorizes payment"的文案纪律）、demo 旁白稿
- **共同**：契约冻结评审（D2）、三次集成日、彩排

## 六、模块级完成定义（DoD）

每模块提交须满足：① 对契约的单元测试绿 ② 对 fixture 的端到端用例绿 ③ 安全清单对应项过 ④ README 一段（接口+运行方式）⑤ 不引入契约外的跨模块 import。集成里程碑另加：I1 = 真链单 Job 全生命周期；I2 = 真实 402 支付回执入账本；I3 = 六幕冷启动串通 + 注入回归绿。


---

## 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-07-14 | 初版：九模块/六契约/三集成/四泳道 |
| v1.1 | 2026-07-28 | 流水线装备第 0 步（Circle Skills + MCP）；C4 账本契约按 Gateway 批量结算修订（ref_type 三态）；M1 的 X402Client 按官方 buyer quickstart 定义 |
| v1.2 | 2026-07-28 | 状态表更新：M2 完成并 live（msb-agent，含 ERC-8004 注册 Agent ID 851930、Marketplace 已申请）、M8 大部完成、M1 部分完成；法域 DE→EU；泳道图替换为 7/28–8/1 冲刺计划；P&L 结构先行原则与版税行前提入档；M5/M7 明确降级路径 |

**日历注记（2026-07-28）**：距 8/1 提交余 4 天，按原 19 天计划应处于 Week 3 打磨期（D15–19：彩排、录屏、README、提交材料）。若实际进度落后，立即执行砍单顺序并将剩余时间全部让给 I3（全流程串通）与备份视频——提交物的底线是：可运行的案件主线 + 录屏 + 三份文档。
