/**
 * **仅供单测**的 SA 夹具构造器。
 *
 * 放在 `src/` 而不是某个 `.test.ts` 里，是因为三检的三个测试文件与
 * `verify.test.ts` 都要用同一份 SA——四处各写一份夹具，改一个字段就要改四遍，
 * 迟早漂移成四份不一样的"同一个"SA。
 *
 * 纪律：本文件不读环境变量、不发网络请求；签名账户由调用方注入（测试里当场生成）。
 */

import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

import { signSaAttestation } from "@citely/engine/sa";
import type { SaBody, SaLeg, SettlementAuthorization } from "@citely/engine/sa";

/** 演示用收款方地址（不是任何 Citely 地址）。 */
export const FIXTURE_PAYEE = `0x${"1".repeat(40)}` as Address;

/** 演示用 Module 引用。 */
export const FIXTURE_MODULE = { module_id: "us-msb", version: "2026.07.1" } as const;

/** 夹具覆盖的 rubric 判定项。 */
export const FIXTURE_RUBRIC_ITEM_IDS: readonly string[] = ["msb-1", "msb-2"];

/**
 * 构造一条结算腿。
 *
 * @param over - 要覆盖的字段
 * @returns 结算腿
 */
export function fixtureLeg(over: Partial<SaLeg> = {}): SaLeg {
  return {
    party: "payee-corp",
    payee: FIXTURE_PAYEE,
    amount_nominal: "1500000",
    condition: "PASS",
    basis: FIXTURE_RUBRIC_ITEM_IDS.map((id) => ({
      item_id: id,
      verdict: "confirmed_exempt",
      source: "31 CFR § 1010.100(ff)",
    })),
    confidence: "high",
    ...over,
  };
}

/**
 * 构造 SA 正文。
 *
 * @param over - 要覆盖的字段
 * @returns SA 正文（不含 attestation）
 */
export function fixtureSaBody(over: Partial<SaBody> = {}): SaBody {
  const legs = over.legs ?? [fixtureLeg()];
  const covered = new Set(legs.flatMap((leg) => leg.basis.map((b) => b.item_id)));
  return {
    case_id: "citely-demo-0001",
    sa_version: "1",
    bound_to: { job_id: "12", expires_at: "2026-08-01T00:00:00.000Z" },
    modules_used: [{ ...FIXTURE_MODULE, evidence_hash: `0x${"3".repeat(64)}` as Hex }],
    legs,
    preview: { condition_summary: "1 leg PASS", items_covered: covered.size },
    ...over,
  };
}

/**
 * 构造一份签好名的完整 SA。
 *
 * @param params - 签名账户与要覆盖的正文字段
 * @returns 完整 SA
 */
export async function fixtureSa(params: {
  readonly account: LocalAccount;
  readonly body?: Partial<SaBody>;
  readonly chainId?: number;
}): Promise<SettlementAuthorization> {
  const body = fixtureSaBody(params.body ?? {});
  const attestation = await signSaAttestation({
    body,
    account: params.account,
    signedAt: new Date("2026-07-28T00:00:00.000Z"),
    ...(params.chainId === undefined ? {} : { chainId: params.chainId }),
  });
  return { ...body, attestation };
}
