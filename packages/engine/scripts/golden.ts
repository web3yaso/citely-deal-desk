/**
 * golden 录制与校验（`docs/design/llm-provider-openai.md` §4.3 / §7 第 4 组）。
 *
 * ```
 * pnpm -F @citely/engine golden:record   # 真实调 API，把判定结果写盘（花钱）
 * pnpm -F @citely/engine golden:verify   # cache_only 跑一遍，任何 miss 即失败（零网络）
 * ```
 *
 * ## 它在演示里的位置
 *
 * golden cache 是本项目**唯一**的确定性承诺来源（§2.4 的 L1）：
 * 相同输入 → 相同 cache key → 命中 → **字节级相同输出**。
 * E3「拔网线演示」就是靠它——断网 + `ADJUDICATOR_MODE=cache_only` 跑完整 demo，
 * 输出与联网时逐字节相同。所以 `golden:verify` 全绿是彩排的前置条件。
 *
 * ## 模型指纹进 cache key
 *
 * 换模型（如 2026-07-30 从不存在的 5.6 snapshot 换到 `gpt-5.4-mini-2026-03-17`）
 * 会让**全部旧 golden 失效**——这是设计预期的代价，不是 bug。重录即可。
 */

import { fileURLToPath } from "node:url";

import { loadDotEnvFile } from "@citely/chain";
import { CLEAN_DEAL_INPUT, INJECTED_DEAL_INPUT } from "@citely/demo/fixtures";
// **共用演示主线的 intake()**：facts 进 cache key，两边不一致就录出一批
// 演示永远命中不了的 golden（2026-07-30 首次录制就是这么白录的）。
import { intake } from "@citely/demo/slice/stages";

import { adjudicateItem } from "../src/adjudicator/index.js";
import { FileGoldenCache } from "../src/adjudicator/cache.js";
import { GoldenCacheMissError } from "../src/adjudicator/errors.js";
import { createAdjudicatorLLM } from "../src/adjudicator/llm/factory.js";
import { findRepoRoot } from "../src/db/path.js";
import { loadRubric } from "../src/rubric/index.js";
import type { SanitizedFacts } from "../src/sandbox/types.js";
import { createLogger } from "../src/util/logger.js";

const log = createLogger("golden");

/** 要录的两份材料：干净版与注入版。注入版必须一起录，否则 A8 的断言没有 golden 可依。 */
function materials(): readonly { readonly label: string; readonly facts: SanitizedFacts }[] {
  return [
    { label: "clean", facts: intake(CLEAN_DEAL_INPUT) },
    { label: "injected", facts: intake(INJECTED_DEAL_INPUT) },
  ];
}

interface RunOptions {
  readonly mode: "record" | "cache_only";
}

async function run(options: RunOptions): Promise<void> {
  const repoRoot = findRepoRoot();
  loadDotEnvFile(`${repoRoot}/.env`);

  const rubricPath = fileURLToPath(new URL("../../../rubrics/us-msb.json", import.meta.url));
  const loaded = loadRubric(rubricPath);

  // 录制时必须走真 provider；校验时用同一个工厂，但模式是 cache_only（不联网）。
  const llm = createAdjudicatorLLM({ ...process.env, ADJUDICATOR_MODE: options.mode });
  const cache = new FileGoldenCache({
    dir: `${repoRoot}/demo/golden/adjudication`,
    provider: llm.fingerprint.provider,
    model: llm.fingerprint.model,
  });

  log.info(options.mode === "record" ? "recording goldens (this calls the API)" : "verifying goldens (offline)", {
    model: llm.fingerprint.model,
    temperature: llm.fingerprint.temperature,
    reasoning_effort: llm.fingerprint.reasoningEffort,
    rubric: `${loaded.id}@${loaded.rubric.version}`,
    items: loaded.rubric.items.length,
    dir: cache.dir,
  });

  let hits = 0;
  let misses = 0;
  const failures: string[] = [];

  for (const { label, facts } of materials()) {
    for (const item of loaded.rubric.items) {
      try {
        const envelope = await adjudicateItem(
          {
            caseId: `golden-${label}`,
            rubric: {
              id: loaded.id,
              version: loaded.rubric.version,
              verdict_states: loaded.rubric.verdict_states,
            },
            item,
            facts,
          },
          { llm, cache, mode: options.mode },
        );
        if (envelope.provenance.cacheHit) hits += 1;
        else misses += 1;
        log.info(`${label}/${item.id}`, {
          verdict: envelope.result.verdict,
          gray_type: envelope.result.gray_type ?? "(none)",
          confidence: envelope.result.confidence,
          risk_flags: envelope.result.risk_flags,
          cache_hit: envelope.provenance.cacheHit,
          cache_key: envelope.provenance.cacheKey,
          repairs: envelope.provenance.repairs,
        });
      } catch (err: unknown) {
        if (err instanceof GoldenCacheMissError) {
          misses += 1;
          failures.push(`${label}/${item.id} → cache miss (${err.cacheKey})`);
          log.error(`${label}/${item.id} MISS`, { cache_key: err.cacheKey });
          continue;
        }
        throw err;
      }
    }
  }

  log.info("done", { hits, misses, failures: failures.length });

  if (options.mode === "cache_only" && failures.length > 0) {
    // 演示模式下"静默降级"比"响亮失败"危险得多——彩排前必须全绿。
    log.error("golden verification FAILED: run golden:record first", { misses: failures.length });
    process.exitCode = 1;
  }
}

const mode = process.argv.includes("--verify") ? "cache_only" : "record";
run({ mode }).catch((err: unknown) => {
  log.error("golden run failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
