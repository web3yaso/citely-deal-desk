/**
 * 演示用信任根的准备。
 *
 * 真实模式读随包的 `attestations/registry.json` 与 `modules.json`——缺文件即
 * 响亮抛错，没有"默认信任任何人"这条路。
 *
 * dry-run 且用一次性密钥时（worktree 里没有 `.env`），把同样两份文件**写到临时目录再
 * 用同一个加载器读回来**。刻意不走"直接在内存里拼一个 registry 对象"的捷径：
 * 那样加载与解析这两段代码在演示里就一次都没被执行过，而它们恰恰是
 * 「文件缺失 → 抛错」这条安全性质的载体。排练要连着易错的那一段一起练。
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAttestationManifest,
  loadTrustRegistry,
  MANIFEST_VERSION,
  MODULE_MANIFEST_PATH,
  signAttestationEntry,
  TRUST_REGISTRY_PATH,
} from "@citely/verifier";
import type { AttestationManifest, TrustRegistry } from "@citely/verifier";
import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

export interface TrustBundle {
  readonly registry: TrustRegistry;
  readonly manifest: AttestationManifest;
  /** 两份文件的实际来源，打印给人看，避免"我以为读的是仓库那份"。 */
  readonly source: string;
}

/** {@link prepareEphemeralTrust} 的参数。 */
export interface EphemeralTrustParams {
  /** SA 的签名者 = 运营钱包地址（合约 §5.1）。 */
  readonly operator: Address;
  /** 一次性 Module 认证账户。与运营、验证器密钥都不是同一把。 */
  readonly attester: LocalAccount;
  /** SA 引用到的 Module，逐条签认证。 */
  readonly modules: readonly { readonly moduleId: string; readonly version: string }[];
  /** 规则集哈希。演示里用 Module 响应的 `evidence_hash`。 */
  readonly rulesHash: Hex;
  readonly chainId: number;
}

/**
 * 生成一次性信任根并落到临时目录，再经正式加载器读回。
 *
 * @param params - 运营地址、认证账户与要认证的 Module 列表
 * @returns 读回来的信任根与认证清单
 */
export async function prepareEphemeralTrust(
  params: EphemeralTrustParams,
): Promise<TrustBundle> {
  const dir = mkdtempSync(join(tmpdir(), "citely-slice-trust-"));
  const registryPath = join(dir, "registry.json");
  const manifestPath = join(dir, "modules.json");

  writeFileSync(
    registryPath,
    JSON.stringify(
      { citelySigners: [params.operator], moduleAttesters: [params.attester.address] },
      null,
      2,
    ),
    "utf8",
  );

  const entries = [];
  for (const module of params.modules) {
    entries.push(
      await signAttestationEntry({
        moduleId: module.moduleId,
        version: module.version,
        rulesHash: params.rulesHash,
        account: params.attester,
        chainId: params.chainId,
      }),
    );
  }
  writeFileSync(
    manifestPath,
    JSON.stringify({ manifest_version: MANIFEST_VERSION, entries }, null, 2),
    "utf8",
  );

  return {
    registry: loadTrustRegistry(registryPath),
    manifest: loadAttestationManifest(manifestPath),
    source: `${dir}（一次性演示信任根）`,
  };
}

/**
 * 读取随包的正式信任根。
 *
 * @returns 信任根与认证清单
 * @throws {Error} 两份文件任一缺失——附带该怎么补的说明，别让人对着 ENOENT 猜
 * @throws {TrustRegistryError} `registry.json` 非法
 * @throws {AttestationManifestError} `modules.json` 非法
 */
export function loadRepoTrust(): TrustBundle {
  assertRepoTrustPresent();
  return {
    registry: loadTrustRegistry(TRUST_REGISTRY_PATH),
    manifest: loadAttestationManifest(MODULE_MANIFEST_PATH),
    source: TRUST_REGISTRY_PATH,
  };
}

/** 仓库里的正式信任根是否两份都在。 */
export function repoTrustPresent(): boolean {
  return existsSync(TRUST_REGISTRY_PATH) && existsSync(MODULE_MANIFEST_PATH);
}

/**
 * 断言正式信任根齐备，缺什么就说清楚怎么补。
 *
 * @throws {Error} 任一文件缺失
 */
function assertRepoTrustPresent(): void {
  const missing: string[] = [];
  if (!existsSync(TRUST_REGISTRY_PATH)) {
    missing.push(
      `${TRUST_REGISTRY_PATH}（照 registry.example.json 填：citelySigners = 运营钱包地址，` +
        `moduleAttesters = Module 认证钱包地址）`,
    );
  }
  if (!existsSync(MODULE_MANIFEST_PATH)) {
    missing.push(
      `${MODULE_MANIFEST_PATH}（先照 modules.source.example.json 建 modules.source.json，` +
        `再跑 pnpm -F @citely/verifier sign:attestations）`,
    );
  }
  if (missing.length > 0) {
    throw new Error(`验证器信任根缺失，无法进行检查①②：\n  - ${missing.join("\n  - ")}`);
  }
}
