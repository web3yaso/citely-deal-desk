/**
 * 进程内三检 + 收口——**仅限本地联调**。
 *
 * 这条路径下主服务与验证器在同一个进程、共用同一套环境变量，
 * 所以「验证器是独立进程、独立密钥」这条对外主张在本模式下**不成立**。
 * 目标形态是 `verify-client.ts` 的远端模式（Railway 上的第二个服务）。
 *
 * 信任根（`attestations/registry.json` + `modules.json`）从仓库读，
 * **缺文件即响亮抛错**——没有"默认信任任何人"这条路。
 */

import type { JobClient } from "@citely/chain";
import type { SettlePort, VerifyPort } from "@citely/engine/orchestrator";
import {
  loadAttestationManifest,
  loadTrustRegistry,
  MODULE_MANIFEST_PATH,
  settleVerifiedJob,
  TRUST_REGISTRY_PATH,
  verifySettlementAuthorization,
} from "@citely/verifier";
import type { VerificationReport } from "@citely/verifier";

export interface InProcessVerifierOptions {
  readonly jobClient: JobClient;
  readonly chainId: number;
  /** 信任注册表路径，默认仓库内那份。 */
  readonly registryPath?: string;
  /** Module 认证清单路径，默认仓库内那份。 */
  readonly manifestPath?: string;
}

/**
 * 端口按**验证器的完整报告**实例化泛型，而不是退化成结构化视图：
 * 收口要用到 `reasonHash` 之外的字段，退化后类型对不上。
 */
export interface InProcessVerifier {
  readonly verify: VerifyPort<VerificationReport>;
  readonly settle: SettlePort<VerificationReport>;
}

/**
 * 创建进程内的三检与收口端口。
 *
 * @param options - 链上客户端、链 ID 与信任根路径
 * @returns 可注入 engine `RunCaseDeps` 的两个端口
 * @throws {Error} 信任根文件缺失或解析失败
 */
export function createInProcessVerifier(options: InProcessVerifierOptions): InProcessVerifier {
  // 启动即加载：信任根有问题要在起服务的时候就炸，而不是等第一个案件跑到一半。
  const registry = loadTrustRegistry(options.registryPath ?? TRUST_REGISTRY_PATH);
  const manifest = loadAttestationManifest(options.manifestPath ?? MODULE_MANIFEST_PATH);

  return {
    verify: (request) =>
      verifySettlementAuthorization({
        sa: request.sa,
        // engine 传的是 LoadedRubric，三检要的是 rubric 正文。
        rubric: request.rubric.rubric,
        manifest,
        registry,
        submittedDeliverableHash: request.submittedDeliverableHash,
        chainId: request.chainId,
      }),
    settle: async (request) => {
      const action = await settleVerifiedJob({
        jobClient: options.jobClient,
        jobId: request.jobId,
        report: request.report,
      });
      // **只回端口声明的两个字段**。verifier 的 `SettlementAction` 还带一个
      // `jobId: bigint`，而编排会把返回值原样写进运行快照，快照要过
      // `JSON.stringify`——bigint 进去当场抛错。结构化类型允许多带字段，
      // 编译期发现不了，只有真跑才炸（演示切 runCase 时实测到）。
      return { action: action.action, txHash: action.txHash };
    },
  };
}
