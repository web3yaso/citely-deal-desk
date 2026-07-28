/**
 * 纵切各阶段的纯逻辑（`run-vertical-slice.ts` 的实现体，拆出来是为了可单测）。
 *
 * 阶段划分照合约：intake → 8183 → 判定 → x402 → SA → 三检 → 收口。
 * 每个阶段都是"输入 → 输出"的纯函数或只依赖注入客户端的 async 函数，
 * 不读环境变量、不自己决定模式。
 */

import type { DealInput, JobFeeRates, ModuleResponse } from "@citely/chain";
import { splitFees } from "@citely/chain";
import type { LoadedRubric } from "@citely/engine/rubric";
import { buildLegs, type PolicyLegInput } from "@citely/engine/policy";
import { buildSettlementAuthorization } from "@citely/engine/sa";
import type { SaLeg, SaModuleUsed, SettlementAuthorization } from "@citely/engine/sa";
import { sanitizeMaterial } from "@citely/engine/sandbox";
import type { SanitizedFacts } from "@citely/engine/sandbox";
import type { Address } from "viem";
import type { LocalAccount } from "viem/accounts";

/** 判定器给出的每个 rubric item 的 verdict。只流向 `basis[]` 与 `confidence`。 */
export type ItemVerdicts = Readonly<Record<string, PolicyLegInput["basis"][number]["verdict"]>>;

/**
 * intake：把案件材料过沙箱。
 *
 * 不变量 5：材料是数据不是指令。沙箱输出是材料能到达判定器的唯一形态。
 *
 * @param deal - 合成案件输入
 * @returns 结构化事实（含确定性注入检测结果）
 */
export function intake(deal: DealInput): SanitizedFacts {
  return sanitizeMaterial({ fields: { ...deal.evidence, activity: deal.activity } });
}

/** {@link buildSettlementLegs} 的参数。 */
export interface BuildLegsParams {
  readonly payee: Address;
  readonly amountAtomic: bigint;
  readonly moduleResponse: ModuleResponse;
  readonly rubric: LoadedRubric;
  readonly verdicts: ItemVerdicts;
}

/**
 * 组装 SA 的 `legs[]`。
 *
 * **condition 只由 Module 结果推导**（不变量 2）：本函数把 `moduleResponse`
 * 交给 Policy Engine 的 `buildLegs`，判定器的 verdict 只进 `basis[]` 与 `confidence`。
 * 这两条路径在 engine 的类型签名上就是分开的，这里改不了。
 *
 * @param params - 收款方、金额、Module 结果、rubric 与各判定项 verdict
 * @returns SA 的 legs
 */
export function buildSettlementLegs(params: BuildLegsParams): readonly SaLeg[] {
  const basis = params.rubric.rubric.items.map((item) => {
    const verdict = params.verdicts[item.id];
    if (verdict === undefined) {
      // 漏判定项就组不出合规的 SA，检查③也会拦——这里提前响亮失败，定位更快。
      throw new Error(`missing adjudication verdict for rubric item ${item.id}`);
    }
    return { item_id: item.id, verdict, source: item.source };
  });

  return buildLegs([
    {
      party: "payee",
      payee: params.payee,
      amount_nominal: params.amountAtomic.toString(),
      modules: [
        {
          overall: params.moduleResponse.overall,
          settlement_constraints: params.moduleResponse.settlement_constraints,
        },
      ],
      basis,
    },
  ]);
}

/** {@link assembleSa} 的参数。 */
export interface AssembleSaParams {
  readonly caseId: string;
  readonly jobId: bigint;
  readonly expiresAt: Date;
  readonly moduleResponse: ModuleResponse;
  readonly legs: readonly SaLeg[];
  readonly itemsCovered: number;
  /** 由 `OPERATOR_PRIVATE_KEY` 派生（合约 §5.1：SA 的签名者是运营密钥）。 */
  readonly operatorAccount: LocalAccount;
  readonly chainId: number;
}

/**
 * 组装并由运营密钥签名 SA。
 *
 * @param params - 绑定信息、Module 版本、腿与签名账户
 * @returns 完整 SA
 */
export async function assembleSa(params: AssembleSaParams): Promise<SettlementAuthorization> {
  const modulesUsed: readonly SaModuleUsed[] = [
    {
      module_id: params.moduleResponse.module,
      version: params.moduleResponse.version,
      evidence_hash: `0x${params.moduleResponse.evidence_hash}`,
    },
  ];
  return await buildSettlementAuthorization({
    caseId: params.caseId,
    jobId: params.jobId,
    expiresAt: params.expiresAt,
    modulesUsed,
    legs: params.legs,
    itemsCovered: params.itemsCovered,
    account: params.operatorAccount,
    chainId: params.chainId,
  });
}

/** `complete` 后各方实收（合约 §2.4）。 */
export interface FeeBreakdown {
  readonly budget: bigint;
  readonly platformFee: bigint;
  readonly evaluatorFee: bigint;
  readonly net: bigint;
}

/**
 * 按**链上读回的**费率算净额。
 *
 * ⚠️ 演示打印金额时**不许断言 "provider 收到 = budget"**：`complete` 会扣
 * `platformFee` 与 `evalFee`，provider 只得 `net`。费率一律读链上 view，
 * 不许硬编码——硬编码会在费率一改时把对账变成假通过。
 *
 * @param budget - 名义案件费（6 位小数原子单位）
 * @param fees - 链上读回的费率
 * @returns 三方金额拆分
 */
export function feeBreakdown(budget: bigint, fees: JobFeeRates): FeeBreakdown {
  const { platformFee, evaluatorFee, net } = splitFees(budget, fees);
  return { budget, platformFee, evaluatorFee, net };
}
