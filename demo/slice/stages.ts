/**
 * 纵切各阶段的纯逻辑（`run-vertical-slice.ts` 的实现体，拆出来是为了可单测）。
 *
 * 阶段划分照合约：intake → 8183 → 判定 → x402 → SA → 三检 → 收口。
 * 每个阶段都是"输入 → 输出"的纯函数或只依赖注入客户端的 async 函数，
 * 不读环境变量、不自己决定模式。
 */

import type { DealInput, JobFeeRates, ModuleResponse } from "@citely/chain";
import { entriesForComplete } from "@citely/engine/ledger";
import type { LedgerEntry } from "@citely/engine/ledger";
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

/** `complete` 后各方实收（合约 §2.4），**全部从账本条目读出**。 */
export interface FeeBreakdown {
  readonly budget: bigint;
  readonly platformFee: bigint;
  readonly evaluatorFee: bigint;
  readonly net: bigint;
  /** 产出上面这些数字的账本条目。终验拿它跟链上事件对账。 */
  readonly entries: readonly LedgerEntry[];
}

/** {@link completeLedger} 的参数。 */
export interface CompleteLedgerParams {
  readonly caseId: string;
  readonly jobId: bigint;
  readonly txHash: string;
  readonly budget: bigint;
  /** **链上读回的**费率。演示脚本不许自带费率常量。 */
  readonly fees: JobFeeRates;
}

/**
 * 产出 `complete` 的账本条目，并从条目里读出要打印的金额。
 *
 * **演示脚本自己不算一遍净额**——那样就有两套算法，对上了也不能证明账本是对的。
 * 这里调 engine 的 `entriesForComplete`（账本的唯一实现），打印的数字就是
 * 将来跟链上 `PaymentReleased` 事件对账的那几个 `amount_actual`。
 *
 * 各字段来源：
 * - `net` = 运营钱包那条的 `amount_actual`；
 * - `evaluatorFee` = 验证器钱包那条的 `amount_actual`；
 * - `platformFee` = `budget - net - evaluatorFee`（去 8183 平台金库，不是我方钱包，
 *   所以不入账，只体现为第一条的名义与实收之差）。
 *
 * ⚠️ 打印时**不许断言 "provider 收到 = budget"**，也不许断言"一定不等于"——
 * 费率是链上变量，当前部署可能就是 0。照实显示读到的数。
 *
 * @param params - 案件、Job、交易哈希、预算与链上费率
 * @returns 账本条目与从中读出的金额拆分
 */
export function completeLedger(params: CompleteLedgerParams): FeeBreakdown {
  const entries = entriesForComplete({
    caseId: params.caseId,
    jobId: params.jobId,
    txHash: params.txHash,
    budget: params.budget,
    fees: params.fees,
  });

  const operatorEntry = entries.find((e) => e.account === "operator");
  const verifierEntry = entries.find((e) => e.account === "verifier");
  if (operatorEntry === undefined || verifierEntry === undefined) {
    throw new Error("ledger must produce one operator entry and one verifier entry");
  }

  const net = operatorEntry.amount_actual;
  const evaluatorFee = verifierEntry.amount_actual;
  return {
    budget: params.budget,
    platformFee: params.budget - net - evaluatorFee,
    evaluatorFee,
    net,
    entries,
  };
}
