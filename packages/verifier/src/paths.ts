/**
 * 验证器随包资产的路径。
 *
 * 信任根与认证清单是**仓库内的公开资产**（纯地址与签名，无秘密），
 * 落在包目录里而不是靠调用方传路径：路径一旦可配置，"默认信任谁"就变成
 * 部署时的隐式决定，审计时看不见。
 */

import { dirname, join } from "node:path";

/** 包根目录（`packages/verifier/`）。 */
export const PACKAGE_ROOT = dirname(import.meta.dirname);

/** 随包资产目录。 */
export const ATTESTATIONS_DIR = join(PACKAGE_ROOT, "attestations");

/**
 * 信任根：`{citelySigners, moduleAttesters}`。纯地址，无秘密，**应当入库**——
 * 信任根要可审计、可 diff、可评审，藏起来就没人看得见它什么时候变了。
 *
 * 之所以仓库里目前只有 `registry.example.json`：真实的运营钱包与认证钱包地址
 * 取决于实际部署用的密钥，本 worktree 拿不到。地址确定后按模板填成 `registry.json` 入库。
 * 缺失时加载器响亮抛错——没有「默认信任任何人」这条路。
 */
export const TRUST_REGISTRY_PATH = join(ATTESTATIONS_DIR, "registry.json");

/** 信任根模板（入库，纯说明用）。 */
export const TRUST_REGISTRY_EXAMPLE_PATH = join(ATTESTATIONS_DIR, "registry.example.json");

/**
 * 已签名的 Module 版本认证清单。
 *
 * 由 `scripts/sign-attestations.ts` 离线生成（需要 Module 认证密钥）。
 * 生成后可入库（只有签名与公开地址）；缺失或条目缺失时检查②响亮判不通过，
 * 绝不"找不到认证就当通过"。
 */
export const MODULE_MANIFEST_PATH = join(ATTESTATIONS_DIR, "modules.json");

/**
 * 待签名的认证源清单（无秘密，可入库）。
 *
 * 由运营方按 `modules.source.example.json` 填写：每条给出 `module_id` / `version`
 * 与规则集的本地快照路径 `rules_file`（`rules_hash` 由快照算出，不手填）。
 */
export const MODULE_SOURCE_PATH = join(ATTESTATIONS_DIR, "modules.source.json");

/** 认证源清单模板（入库）。 */
export const MODULE_SOURCE_EXAMPLE_PATH = join(ATTESTATIONS_DIR, "modules.source.example.json");
