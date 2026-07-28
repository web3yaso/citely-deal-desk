/**
 * provider 工厂（`docs/design/llm-provider-openai.md` §5 环境变量表）。
 *
 * 纪律：
 * - **错误信息里绝不回显 key 值**，只说"缺哪个变量"；
 * - `cache_only`（现场演示 / 无 key CI）下缺 `OPENAI_API_KEY` 必须能正常构造——
 *   那条路径根本不联网；
 * - `OPENAI_MODEL` 必须是**带日期的 snapshot ID**：别名会随 OpenAI 侧更新漂移，
 *   漂移即 golden cache 静默失效（§4.3 失效策略表）。
 */

import { isDatedModelSnapshot } from "@citely/chain";

import { AdjudicatorConfigError, modeRequiresNetwork, parseAdjudicatorMode } from "../modes.js";
import { FakeAdjudicatorLLM } from "./fake.js";
import { OpenAiAdjudicatorLLM } from "./openai.js";
import type { AdjudicatorLLM } from "./types.js";

/** 环境变量来源（`process.env` 的最小只读视图，便于测试注入）。 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

function readOptional(env: EnvSource, key: string): string | undefined {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

function readNumber(env: EnvSource, key: string, fallback: number): number {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new AdjudicatorConfigError(`${key} must be a finite number, got: ${raw}`);
  }
  return value;
}

/**
 * 按环境变量构造 provider。
 *
 * @param env - 环境变量（默认 `process.env`）
 * @returns provider 实例
 * @throws {AdjudicatorConfigError} 变量缺失或取值非法（消息中不含任何密钥值）
 */
export function createAdjudicatorLLM(env: EnvSource = process.env): AdjudicatorLLM {
  const provider = readOptional(env, "LLM_PROVIDER") ?? "openai";
  if (provider === "fake") {
    return new FakeAdjudicatorLLM({ model: readOptional(env, "OPENAI_MODEL") ?? "fake-1" });
  }
  if (provider !== "openai") {
    throw new AdjudicatorConfigError(`LLM_PROVIDER must be one of openai|fake, got: ${provider}`);
  }

  const model = readOptional(env, "OPENAI_MODEL");
  if (model === undefined) {
    throw new AdjudicatorConfigError("OPENAI_MODEL is required (dated snapshot ID)");
  }
  if (!isDatedModelSnapshot(model)) {
    throw new AdjudicatorConfigError(
      `OPENAI_MODEL must be a dated snapshot ID (…-YYYY-MM-DD), got: ${model}`,
    );
  }

  const mode = parseAdjudicatorMode(readOptional(env, "ADJUDICATOR_MODE"));
  const apiKey = readOptional(env, "OPENAI_API_KEY");
  if (apiKey === undefined && modeRequiresNetwork(mode)) {
    // 只说缺了哪个变量，不说它"应该长什么样"，更不回显任何值。
    throw new AdjudicatorConfigError(
      `OPENAI_API_KEY is required in ADJUDICATOR_MODE=${mode} (only cache_only runs offline)`,
    );
  }

  const baseURL = readOptional(env, "OPENAI_BASE_URL");
  const reasoningEffort = readOptional(env, "OPENAI_REASONING_EFFORT");
  return new OpenAiAdjudicatorLLM({
    // cache_only 下允许无 key：这个实例不会被调用（miss 直接抛 GoldenCacheMissError）。
    apiKey: apiKey ?? "",
    model,
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    temperature: readNumber(env, "OPENAI_TEMPERATURE", 0),
    timeoutMs: readNumber(env, "ADJUDICATOR_TIMEOUT_MS", 30_000),
  });
}
