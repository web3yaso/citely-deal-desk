/**
 * 判定器的四种运行模式（`docs/design/llm-provider-openai.md` §4.3）。
 *
 * 单独成文件是为了让 `llm/factory.ts` 能判断"这个模式要不要联网"，
 * 而**不必 import `cache.ts`**——`llm/*` 不认识 cache 是硬性依赖方向纪律。
 */

export type AdjudicatorMode = "cache_first" | "cache_only" | "record" | "live";

export const ADJUDICATOR_MODES: readonly AdjudicatorMode[] = [
  "cache_first",
  "cache_only",
  "record",
  "live",
];

export class AdjudicatorConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdjudicatorConfigError";
  }
}

/** 解析 `ADJUDICATOR_MODE`，缺省 `cache_first`。 */
export function parseAdjudicatorMode(raw: string | undefined): AdjudicatorMode {
  if (raw === undefined || raw === "") return "cache_first";
  if (!ADJUDICATOR_MODES.includes(raw as AdjudicatorMode)) {
    throw new AdjudicatorConfigError(
      `ADJUDICATOR_MODE must be one of ${ADJUDICATOR_MODES.join("|")}, got: ${raw}`,
    );
  }
  return raw as AdjudicatorMode;
}

/**
 * 该模式是否可能发起真实 API 调用。
 * 只有 `cache_only` 保证不联网——它是现场演示与无 key CI 的模式。
 */
export function modeRequiresNetwork(mode: AdjudicatorMode): boolean {
  return mode !== "cache_only";
}
