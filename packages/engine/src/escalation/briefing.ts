/**
 * 会谈卷宗生成器（v2.3 §3.1 列了"卷宗生成器"，纵切阶段没做）。
 *
 * 卷宗是交给**人类专家**看的陈述材料，随出口 4 的 ESCALATE 腿一起产出。
 *
 * ## 三条硬约束（对应主导交办的原话）
 *
 * 1. **引用的判定项、法源、Module 版本必须来自确定性数据，不许 LLM 编**——
 *    所以 {@link buildBriefingPack} 的入参全是结构化事实，`facts` 段完全由它们
 *    机械组装；LLM 只能碰 {@link BriefingNarrative} 那一个字段。
 * 2. **卷宗不含任何 PASS/HOLD/ESCALATE 的改判空间**——它是陈述材料，不是决策文档。
 *    落法：LLM 起草的 `narrative` 里**出现这三个词就报错**
 *    （{@link assertNarrativeIsNotDecisional}）。腿的 condition 只存在于 SA 上，
 *    由 Policy Engine 从 Module 结果算出，卷宗里连提都不提。
 * 3. **正文链下，链上只有哈希**（不变量 4）——{@link briefingPackHash} 的结果进 SA 的
 *    `briefing_pack_hash`，卷宗正文自己落盘。
 *
 * ## 为什么卷宗里没有时间戳
 *
 * 哈希要进 SA、SA 要被签名与复算。带 wall-clock 的话同一个案件每次生成的哈希都不同，
 * golden 复现和"两次组装得到逐字节相同的 SA"就都不成立了。需要时间的话，
 * 用 SA 自己的 `bound_to.expires_at` 与 `attestation.signed_at`——那两个已经有了。
 */

import { canonicalJson } from "../util/canonical.js";
import { sha256Hex0x } from "../util/hash.js";
import type { Hex } from "viem";

/** 一条被升级的判定项在卷宗里的呈现。**全部字段来自确定性数据。** */
export interface BriefingItem {
  readonly item_id: string;
  /** rubric 的问题原文。 */
  readonly question: string;
  /** rubric 的法源标识（`items[].source`）。 */
  readonly source: string;
  /** 判定器给出的 verdict（陈述"我看到了什么"，不是"钱能不能动"）。 */
  readonly verdict: string;
  /** 恒为 `"interpretive"`——出口 4 的定义。 */
  readonly gray_type: "interpretive";
  /** 为什么它是解释性灰色：rubric 的 `confidence_rule` 原文。 */
  readonly confidence_rule: string;
}

/** 卷宗引用的 Module 版本，供专家复算 `evidence_hash`。 */
export interface BriefingModuleRef {
  readonly module_id: string;
  readonly version: string;
  readonly evidence_hash: string;
}

/**
 * LLM 起草的叙述段。
 *
 * 这是判定链路上**唯一**允许自由文本的地方，且它没有任何出口能影响 condition
 * （SA 的 `legs[].condition` 由 `policy/condition.ts` 从 Module 结果算，
 * 那条代码路径不读卷宗）。
 */
export interface BriefingNarrative {
  /** 争点摘要。允许 LLM 起草。 */
  readonly summary: string;
  /** 建议与专家会谈时先问清的问题。允许 LLM 起草。 */
  readonly questions_for_counsel: readonly string[];
}

/** 卷宗（正文，链下）。 */
export interface BriefingPack {
  readonly case_id: string;
  readonly pack_version: "1";
  /** 确定性段：机械组装，LLM 碰不到。 */
  readonly facts: {
    readonly rubric_id: string;
    readonly rubric_version: string;
    readonly modules_used: readonly BriefingModuleRef[];
    readonly items: readonly BriefingItem[];
    /** 材料规范化字节的哈希——卷宗不含材料原文（不变量 4 的同源纪律）。 */
    readonly material_sha256: string;
  };
  /** LLM 可起草段；未起草时为 `null`（模板化最小版即走这条）。 */
  readonly narrative: BriefingNarrative | null;
  readonly disclaimer: string;
}

/** 免责声明。对外呈现必须原样保留（CLAUDE.md 红线）。 */
export const BRIEFING_DISCLAIMER =
  "本卷宗为基于公开法源整理的检查项状态汇编，不构成法律意见；" +
  "其中的判定项状态不代表放款决定，放款条件由 Settlement Authorization 载明，" +
  "并由钱包按自有预设策略核验执行。";

/** 决策性词汇：卷宗的自由文本段里不许出现。 */
const DECISIONAL_TOKENS: readonly string[] = ["PASS", "HOLD", "ESCALATE"];

/** LLM 起草的叙述里出现了决策性词汇。 */
export class DecisionalNarrativeError extends Error {
  public readonly token: string;

  public constructor(token: string) {
    super(
      `briefing narrative must not contain the decisional token "${token}": ` +
        `the pack is a statement of facts, not a decision document (conditions live only on the SA)`,
    );
    this.name = "DecisionalNarrativeError";
    this.token = token;
  }
}

/**
 * 校验叙述段不含 `PASS`/`HOLD`/`ESCALATE`。
 *
 * 用**大写全词**匹配而不是不分大小写地找子串：`hold` 在英文里是常用动词
 * （"funds are on hold pending review" 这种句子该被允许），而 `HOLD` 作为
 * 全大写标记出现，才说明 LLM 在试图表达一个腿的判定。这条边界写进测试。
 *
 * @throws {DecisionalNarrativeError} 命中任一决策性词汇
 */
export function assertNarrativeIsNotDecisional(narrative: BriefingNarrative): void {
  const texts = [narrative.summary, ...narrative.questions_for_counsel];
  for (const token of DECISIONAL_TOKENS) {
    const pattern = new RegExp(`\\b${token}\\b`, "g");
    for (const text of texts) {
      if (pattern.test(text)) throw new DecisionalNarrativeError(token);
    }
  }
}

/** {@link buildBriefingPack} 的参数。全部是确定性数据。 */
export interface BuildBriefingPackParams {
  readonly caseId: string;
  readonly rubricId: string;
  readonly rubricVersion: string;
  readonly modulesUsed: readonly BriefingModuleRef[];
  readonly items: readonly BriefingItem[];
  readonly materialSha256: string;
  /** LLM 起草的叙述段；不传即模板化最小版。 */
  readonly narrative?: BriefingNarrative;
}

/** 卷宗里没有需要人工复核的判定项——那就不该有卷宗。 */
export class EmptyBriefingPackError extends Error {
  public constructor() {
    super("briefing pack requires at least one escalated item (exit 4 is defined by having one)");
    this.name = "EmptyBriefingPackError";
  }
}

/**
 * 组装会谈卷宗。
 *
 * @param params - 确定性事实 + 可选的 LLM 叙述段
 * @returns 卷宗正文（落盘链下）
 * @throws {EmptyBriefingPackError} 没有任何被升级的判定项
 * @throws {DecisionalNarrativeError} 叙述段含决策性词汇
 */
export function buildBriefingPack(params: BuildBriefingPackParams): BriefingPack {
  if (params.items.length === 0) throw new EmptyBriefingPackError();
  if (params.narrative !== undefined) assertNarrativeIsNotDecisional(params.narrative);

  return {
    case_id: params.caseId,
    pack_version: "1",
    facts: {
      rubric_id: params.rubricId,
      rubric_version: params.rubricVersion,
      modules_used: params.modulesUsed,
      items: params.items,
      material_sha256: params.materialSha256,
    },
    narrative: params.narrative ?? null,
    disclaimer: BRIEFING_DISCLAIMER,
  };
}

/**
 * 卷宗哈希 —— 进 SA 的 `briefing_pack_hash`。
 *
 * 与 `deliverableHash` 同一套规范化实现（`util/canonical.ts` 全仓唯一），
 * 所以专家/评委拿到卷宗正文就能自己复算这个哈希、和 SA 上的比对。
 */
export function briefingPackHash(pack: BriefingPack): Hex {
  return sha256Hex0x(new TextEncoder().encode(canonicalJson(pack)));
}
