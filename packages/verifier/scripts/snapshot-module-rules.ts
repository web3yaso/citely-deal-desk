/**
 * 抓取 L1 Module 的**公开规则快照**，供离线签认证清单时算 `rules_hash`。
 *
 * ```
 * pnpm -F @citely/verifier snapshot:modules
 * ```
 *
 * 为什么要有快照、而不是手填 `rules_hash`：认证要绑到**实际规则内容**上。
 * 手填一个数等于认证了一个没人核对过的东西——任何人都无法复算它是否对应
 * 该版本的规则。有了快照，任何人重跑本脚本就能复算出同一个哈希。
 *
 * 快照内容 = 该 module 在 `GET /modules` 里的完整描述（含 `version`、
 * `sources[]` 法源清单、`maintainer`、`pay_to`）+ `GET /modules/:id/schema`
 * 的输入 schema。这是 L1 对"这个版本是什么"的全部公开声明。
 *
 * ⚠️ 本脚本**联网但不付费**（`/modules` 与 `/schema` 都是免费 GET，
 * 只有 `/check` 走 x402）。它不进 CI，是运维动作。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ATTESTATIONS_DIR } from "../src/paths.js";
import { asArray, asRecord, asString } from "../src/parse.js";
import { safeErrorMessage } from "../src/redact.js";

/** msb-agent 基址（合约 §1）。 */
const DEFAULT_BASE_URL = "https://msb-agent-production-769d.up.railway.app";

/** 快照落盘目录。 */
export const RULES_DIR = join(ATTESTATIONS_DIR, "rules");

/**
 * 从 argv 取 `--flag value`。
 *
 * @param flag - 参数名（含 `--`）
 * @param fallback - 未提供时的默认值
 * @returns 参数值
 */
function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

/**
 * 发一个 GET 并解析 JSON。
 *
 * @param url - 完整 URL
 * @returns 解析后的 JSON
 * @throws {Error} 非 2xx 或响应不是合法 JSON
 */
async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${String(res.status)}`);
  return (await res.json()) as unknown;
}

/** 一条快照对应的源清单条目。 */
interface SnapshotResult {
  readonly moduleId: string;
  readonly version: string;
  readonly file: string;
}

/**
 * 抓取单个 module 的规则快照并落盘。
 *
 * @param baseUrl - msb-agent 基址
 * @param descriptor - `GET /modules` 里的一条 module 描述
 * @returns 快照结果
 */
async function snapshotModule(baseUrl: string, descriptor: unknown): Promise<SnapshotResult> {
  const rec = asRecord(descriptor, "modules[]");
  const moduleId = asString(rec["module"], "modules[].module");
  const version = asString(rec["version"], "modules[].version");
  const schemaPath = asString(rec["input_schema_url"], "modules[].input_schema_url");
  const inputSchema = await getJson(`${baseUrl}${schemaPath}`);

  const snapshot = {
    snapshot_version: "1",
    source_url: `${baseUrl}/modules`,
    descriptor: rec,
    input_schema: inputSchema,
  };
  const file = `${moduleId}@${version}.json`;
  writeFileSync(join(RULES_DIR, file), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { moduleId, version, file };
}

async function main(): Promise<void> {
  const baseUrl = arg("--base-url", DEFAULT_BASE_URL);
  mkdirSync(RULES_DIR, { recursive: true });

  const listing = asRecord(await getJson(`${baseUrl}/modules`), "");
  const modules = asArray(listing["modules"], "modules");
  const results: SnapshotResult[] = [];
  for (const descriptor of modules) {
    // 串行：这是运维脚本，不值得为几个请求引入并发与限流处理。
    results.push(await snapshotModule(baseUrl, descriptor));
  }

  // 顺带把源清单也生成出来，省得人工誊抄版本号（誊错就会在真链上验不过）。
  const source = {
    _comment: [
      "由 scripts/snapshot-module-rules.ts 生成，版本号取自线上 GET /modules。",
      "rules_hash 由 rules_file 指向的快照算出，不手填。",
      "签名：pnpm -F @citely/verifier sign:attestations",
    ],
    entries: results.map((r) => ({
      module_id: r.moduleId,
      version: r.version,
      rules_file: `./rules/${r.file}`,
    })),
  };
  writeFileSync(
    join(ATTESTATIONS_DIR, "modules.source.json"),
    `${JSON.stringify(source, null, 2)}\n`,
    "utf8",
  );

  process.stderr.write(
    [
      `snapshotted ${String(results.length)} module(s) -> ${RULES_DIR}`,
      ...results.map((r) => `  ${r.moduleId}@${r.version} -> ${r.file}`),
      `wrote ${join(ATTESTATIONS_DIR, "modules.source.json")}`,
      "",
    ].join("\n"),
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`snapshot-module-rules failed: ${safeErrorMessage(err)}\n`);
  process.exitCode = 1;
}
