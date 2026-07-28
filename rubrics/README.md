# rubrics/

L1 知识层资产：判定逻辑的版本化静态文件，schema 逐字照录
`docs/design/CitelyDealDesk技术实现方案-v2.2.md` §4.1。

- 文件名（不含扩展名）即 `rubric_id`（v2.2 §4.1 的 schema 里没有 `id` 字段，
  而 golden cache key 需要一个稳定标识，故由文件名派生）；
- **rubric 是判定器 system prompt 的唯一内容来源**（不变量 5：材料永不进指令通道）；
- `items[].source` 是 `source_refs` 白名单的来源，多条法源以 ` / `（两侧带空格的斜杠）
  分隔——不用裸 `/`，因为法条编号本身可能含斜杠；
- **改一个字即 golden cache 全量失效**（键含 `rubric_item_sha256`），
  演示前须重录 golden。

## `verdict_states` 只有 3 个值，引擎却是 5 态

v2.2 §4.1 的 `verdict_states` 是 `confirmed_in_scope` / `confirmed_exempt` /
`gray_interpretive`，而引擎 verdict 是 5 态。处理规则见
`docs/design/llm-provider-openai.md` §4.2：线上 JSON Schema **恒为 5 态全集**
（否则每条 item 一个 schema，cache key 爆炸），`gray_data` 与 `unverifiable`
是任何 item 恒可取的**引擎级兜底态**；模型返回越界 verdict 时由后置校验
**保守降级为 `unverifiable`**，绝不反向放宽。

## 免责声明

输出为基于公开法源整理的检查项状态，**不构成法律意见**。
本目录的 rubric 为黑客松演示用途整理，法源引用未经执业律师复核。
