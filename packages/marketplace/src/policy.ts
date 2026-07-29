/**
 * 钱包的**自有预设结算策略**。
 *
 * 措辞与语义红线（CLAUDE.md）：SA 是"条件证明，由钱包按自有预设策略核验执行"。
 * Citely 不授权任何付款，它只出具"这些条件成立"的证明；**付不付、付给谁、付多少，
 * 由本文件里的策略决定**。策略参数由钱包主人事先配置，Citely 无从影响。
 *
 * 因此这里的每一条规则都是**钱包自己的**否决权：
 * 1. 出具方不在钱包的信任名单里 → 不执行（信任名单是钱包的资产，不是 Citely 给的）；
 * 2. SA 过期 / 绑定的 jobId 不是本钱包资助的那一单 → 不执行；
 * 3. 腿的条件不是 `PASS` → 不执行该腿（`HOLD`/`ESCALATE` 一律扣住）；
 * 4. 条件取值钱包看不懂 → 不执行该腿（"看不懂"绝不等于"放行"）；
 * 5. **收款方落在钱包的黑名单里 → 整单中止**。黑名单里装的是 Citely 侧地址：
 *    客户资金永不进我方地址（不变量 3），这条由**客户自己**把关才有意义；
 * 6. 单腿 / 全单金额上限超出 → 整单中止。
 *
 * 全部规则都是确定性纯函数：不联网、不读密钥、不调 LLM。
 */

import type { Address } from "viem";

import type { ObservedCondition, ObservedLeg, ObservedSa } from "./sa-view.js";

/**
 * 钱包放款规则的一句话说明，供报告与 UI 呈现。
 *
 * 集中在这里而不是让每个调用方自己编一句：说法一旦各写各的，
 * 迟早出现"界面上写的规则"和"代码里执行的规则"不一致。
 */
export const PAYOUT_RULE_SUMMARY =
  "仅 condition=PASS 且有判定依据的腿可放款；任一策略级红线命中则整单不付";

/** 钱包的预设策略参数。由钱包主人配置，SA 内容改变不了它。 */
export interface WalletSettlementPolicy {
  /** 钱包信任的 SA 出具方地址。空列表 = 谁都不信。 */
  readonly trustedIssuers: readonly Address[];
  /**
   * 绝不付款的地址（不变量 3 的客户侧把关）。
   * 演示里装的是 Citely 运营 / 验证器地址。
   */
  readonly neverPayTo: readonly Address[];
  /** 单腿金额上限（6 位小数原子单位）。 */
  readonly maxLegAmountAtomic: bigint;
  /** 全单金额上限（6 位小数原子单位）。 */
  readonly maxTotalAmountAtomic: bigint;
  /** 钱包要求 SA 必须引用到的 Module（`module_id@version`）。空 = 不作要求。 */
  readonly requiredModuleRefs: readonly string[];
}

/**
 * **整单**否决理由（策略级红线）。出现任意一条，钱包一分钱都不付。
 *
 * 与 {@link WithheldLeg} 是两个不同的概念，别混为一谈：
 * blocker 是"这份 SA 整体不可信/越界"（出具方不认、过期、收款方在黑名单、超额度）；
 * withheld 是"这条腿的条件没满足"。**只有 blocker 为空、且至少一条腿通过，才会放款**——
 * 所以 `blockers` 为空**不等于**会付款，报告时两者必须分开呈现。
 */
export interface PolicyBlocker {
  readonly code: string;
  readonly detail: string;
}

/** **单腿**被扣住的理由。整单可以没有 blocker，但腿被扣住照样不放这条腿的款。 */
export interface WithheldLeg {
  /** 在 `sa.legs` 里的下标，便于报告时精确定位是哪一条。 */
  readonly legIndex: number;
  readonly party: string;
  /** 该腿的条件原值；`null` 表示钱包不认得这个取值。 */
  readonly condition: ObservedCondition | null;
  readonly code: string;
  readonly detail: string;
}

/** 钱包决定要发出的一笔付款。目标恒为 SA 里的收款方。 */
export interface PlannedPayment {
  readonly party: string;
  readonly to: Address;
  readonly amountAtomic: bigint;
}

/** 钱包的核验结论。 */
export interface SettlementDecision {
  /** 是否执行付款。有任意 blocker 即为 false。 */
  readonly execute: boolean;
  readonly payments: readonly PlannedPayment[];
  readonly withheld: readonly WithheldLeg[];
  readonly blockers: readonly PolicyBlocker[];
}

/** {@link applySettlementPolicy} 的参数。 */
export interface PolicyInput {
  readonly sa: ObservedSa;
  readonly policy: WalletSettlementPolicy;
  /** 钱包实际资助的 jobId。与 SA 绑定的不一致即整单中止。 */
  readonly fundedJobId: bigint;
  /** 判定时刻。注入是为了让测试可复现。 */
  readonly now: Date;
}

function eqCaseless(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 检查 SA 的整单级前置条件（出具方、有效期、jobId、Module 覆盖）。
 *
 * @param input - 策略输入
 * @returns 整单否决理由，空数组表示前置条件全过
 */
function collectSaBlockers(input: PolicyInput): PolicyBlocker[] {
  const { sa, policy, fundedJobId, now } = input;
  const blockers: PolicyBlocker[] = [];

  if (!policy.trustedIssuers.some((addr) => eqCaseless(addr, sa.signer))) {
    blockers.push({ code: "issuer_not_trusted", detail: sa.signer });
  }

  const expiresAt = Date.parse(sa.expiresAt);
  if (Number.isNaN(expiresAt)) {
    blockers.push({ code: "expiry_unparseable", detail: sa.expiresAt });
  } else if (expiresAt <= now.getTime()) {
    blockers.push({ code: "sa_expired", detail: sa.expiresAt });
  }

  if (sa.jobId !== fundedJobId) {
    blockers.push({
      code: "job_id_mismatch",
      detail: `sa ${String(sa.jobId)} != funded ${String(fundedJobId)}`,
    });
  }

  const missing = policy.requiredModuleRefs.filter((ref) => !sa.moduleRefs.includes(ref));
  if (missing.length > 0) {
    blockers.push({ code: "required_module_missing", detail: missing.join(",") });
  }

  if (sa.legs.length === 0) {
    blockers.push({ code: "no_legs", detail: "SA carries no settlement legs" });
  }

  return blockers;
}

/**
 * 判定单条腿**自身**是否可执行。
 *
 * 只看腿的内容，不看策略参数：黑名单与金额上限是**整单级红线**，命中要中止全单，
 * 在 {@link applySettlementPolicy} 里处理；这里只负责"这条腿够不够格"。
 *
 * @param leg - 钱包视图里的一条腿
 * @param legIndex - 该腿在 `sa.legs` 里的下标
 * @returns 扣住理由；`null` 表示该腿可执行
 */
function screenLeg(leg: ObservedLeg, legIndex: number): WithheldLeg | null {
  const at = { legIndex, party: leg.party, condition: leg.condition };
  if (leg.condition === null) {
    // 钱包看不懂的条件取值，一律按最保守处理。
    return { ...at, code: "condition_unrecognized", detail: leg.party };
  }
  if (leg.condition !== "PASS") {
    return { ...at, code: `condition_${leg.condition.toLowerCase()}`, detail: leg.party };
  }
  if (leg.basisCount === 0) {
    return { ...at, code: "leg_without_basis", detail: leg.party };
  }
  if (leg.amountAtomic <= 0n) {
    return { ...at, code: "non_positive_amount", detail: leg.party };
  }
  return null;
}

/**
 * 按钱包的自有预设策略核验一份 SA，并给出付款决定。
 *
 * @param input - SA 视图、策略参数、已资助的 jobId 与判定时刻
 * @returns 钱包的核验结论；`execute === false` 时 `payments` 必为空
 */
export function applySettlementPolicy(input: PolicyInput): SettlementDecision {
  const { sa, policy } = input;
  const blockers = collectSaBlockers(input);
  const withheld: WithheldLeg[] = [];
  const payments: PlannedPayment[] = [];

  for (const [legIndex, leg] of sa.legs.entries()) {
    // 黑名单是整单级红线：SA 里出现指向我方地址的收款腿，说明这份 SA 本身有问题。
    if (policy.neverPayTo.some((addr) => eqCaseless(addr, leg.payee))) {
      blockers.push({ code: "payee_blacklisted", detail: `${leg.party} -> ${leg.payee}` });
      continue;
    }
    if (leg.amountAtomic > policy.maxLegAmountAtomic) {
      blockers.push({
        code: "leg_amount_over_cap",
        detail: `${leg.party}: ${String(leg.amountAtomic)}`,
      });
      continue;
    }
    const reason = screenLeg(leg, legIndex);
    if (reason !== null) {
      withheld.push(reason);
      continue;
    }
    payments.push({ party: leg.party, to: leg.payee, amountAtomic: leg.amountAtomic });
  }

  const total = payments.reduce((sum, p) => sum + p.amountAtomic, 0n);
  if (total > policy.maxTotalAmountAtomic) {
    blockers.push({ code: "total_amount_over_cap", detail: String(total) });
  }

  const execute = blockers.length === 0 && payments.length > 0;
  return { execute, payments: execute ? payments : [], withheld, blockers };
}
