/**
 * 出口 4（解释性 gray）的两样产出物：会谈卷宗 + Review Job 模板（v2.3 §2.2）。
 *
 * 一个便捷入口 {@link buildEscalation} 把两者组装成 SA 的
 * `legs[].escalation` 对象——那是它们唯一的去处。
 */

import type { SaEscalation } from "../sa/types.js";
import { briefingPackHash, buildBriefingPack } from "./briefing.js";
import type { BriefingPack, BuildBriefingPackParams } from "./briefing.js";
import { buildReviewJobTemplate } from "./review-job.js";
import type { BuildReviewJobTemplateParams } from "./review-job.js";

export {
  assertNarrativeIsNotDecisional,
  BRIEFING_DISCLAIMER,
  briefingPackHash,
  buildBriefingPack,
  DecisionalNarrativeError,
  EmptyBriefingPackError,
} from "./briefing.js";
export type {
  BriefingItem,
  BriefingModuleRef,
  BriefingNarrative,
  BriefingPack,
  BuildBriefingPackParams,
} from "./briefing.js";

export {
  buildReviewJobTemplate,
  InvalidReviewJobRolesError,
  isReviewJobTemplate,
  REVIEW_JOB_TEMPLATE_KIND,
  ZERO_ADDRESS,
} from "./review-job.js";
export type { BuildReviewJobTemplateParams, ReviewJobTemplate } from "./review-job.js";

/** {@link buildEscalation} 的返回值：SA 上那一份 + 要落盘的卷宗正文。 */
export interface EscalationBundle {
  /** 放进 `legs[].escalation` 的对象（只含模板与哈希，不含卷宗正文）。 */
  readonly escalation: SaEscalation;
  /** 卷宗正文，**落盘链下**（不变量 4：链上只有哈希）。 */
  readonly briefingPack: BriefingPack;
}

/**
 * 一次性组装出口 4 的产出物。
 *
 * @param params - 卷宗事实 + Review Job 角色与保证金
 * @returns SA 用的 escalation 对象 + 需要落盘的卷宗正文
 */
export function buildEscalation(params: {
  readonly briefing: BuildBriefingPackParams;
  readonly reviewJob: BuildReviewJobTemplateParams;
}): EscalationBundle {
  const briefingPack = buildBriefingPack(params.briefing);
  const template = buildReviewJobTemplate(params.reviewJob);
  return {
    escalation: {
      review_job_template: template,
      briefing_pack_hash: briefingPackHash(briefingPack),
    },
    briefingPack,
  };
}
