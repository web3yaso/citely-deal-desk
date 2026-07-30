/**
 * SA 组装（v2.2 §4.2 全文：case_id / sa_version / bound_to / modules_used /
 * legs[] / preview / attestation）。
 *
 * **措辞纪律（红线，CLAUDE.md）**：SA 是"条件证明，由钱包按自有预设策略核验执行"，
 * **绝不写 "Citely authorizes the payment"**。这条纪律不靠人记得——
 * {@link assertNoForbiddenWording} 在每次组装时扫一遍规范化字节，命中即抛错。
 */

import type { LocalAccount } from "viem/accounts";

import { buildPreview } from "../policy/legs.js";
import { canonicalJson } from "../util/canonical.js";
import { signSaAttestation } from "./sign.js";
import type {
  SaBody,
  SaLeg,
  SaModuleUsed,
  SaPreview,
  SettlementAuthorization,
} from "./types.js";

/** SA 的 schema 版本（v2.2 §4.2 示例值）。 */
export const SA_VERSION = "1";

/**
 * 禁用措辞（小写匹配）。
 *
 * 前三条是"Citely 授权付款"的各种说法——SA 不授权任何付款，它只陈述条件；
 * 后两条是常见的等价滑坡（"批准放款"/"指示钱包付款"）。
 */
export const FORBIDDEN_SA_PHRASES: readonly string[] = [
  "citely authorizes",
  "authorizes the payment",
  "authorize the payment",
  "approves the payment",
  "instructs the wallet to pay",
];

/** SA 文案命中禁用措辞。 */
export class SaWordingError extends Error {
  public readonly phrase: string;

  public constructor(phrase: string) {
    super(`SA contains forbidden wording: ${phrase}`);
    this.name = "SaWordingError";
    this.phrase = phrase;
  }
}

/**
 * 扫描 SA（或任何将随 SA 对外呈现的对象）的规范化字节，命中禁用措辞即抛错。
 *
 * @param value - 待检查的对象
 * @throws {SaWordingError} 命中 {@link FORBIDDEN_SA_PHRASES} 任一条
 */
export function assertNoForbiddenWording(value: unknown): void {
  const text = canonicalJson(value).toLowerCase();
  for (const phrase of FORBIDDEN_SA_PHRASES) {
    if (text.includes(phrase)) throw new SaWordingError(phrase);
  }
}

/** 有效期形状非法。 */
export class InvalidSaExpiryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidSaExpiryError";
  }
}

/**
 * 把确定性的有效期来源归一为 ISO8601 UTC。
 *
 * @param expiresAt - 链上 `expiredAt`（Unix 秒 bigint）或显式 ISO8601 字符串
 * @throws {InvalidSaExpiryError} Unix 秒为非正数，或字符串不是可解析的时刻
 */
export function saExpiresAt(expiresAt: bigint | string): string {
  if (typeof expiresAt === "bigint") {
    if (expiresAt <= 0n) {
      throw new InvalidSaExpiryError(`on-chain expiredAt must be positive, got ${expiresAt.toString()}`);
    }
    // 毫秒精度会引入链上没有的信息；链上就是秒，这里也只用秒。
    return new Date(Number(expiresAt) * 1000).toISOString();
  }

  // ⚠️ 运行期把关，不能只靠类型。
  //
  // 2026-07-30 的真实事故：调用方（未过 typecheck 的 demo，经 tsx 直接跑）传进来一个
  // `Date`。老实现走到下面的 `Date.parse(expiresAt)` —— 它会把 Date 隐式转成字符串
  // 并解析成功，于是函数**把 Date 原样 return 了**，声明的 `: string` 是假的。
  // 那个 Date 一路流进 `bound_to.expires_at`，直到 `canonicalJson` 才炸，
  // 报错点离病根隔了三层。
  //
  // 边界函数的类型签名只是给编译器看的；**跨包/跨运行方式的边界上必须再验一次**。
  if (typeof expiresAt !== "string") {
    const actual =
      expiresAt === null ? "null" : ((expiresAt as object).constructor?.name ?? typeof expiresAt);
    throw new InvalidSaExpiryError(
      `expires_at must be an ISO8601 string or an on-chain expiredAt (bigint seconds), got ${actual}. ` +
        `If you have a Date, do not pass it: SA validity must come from the chain ` +
        `(JobView.expiredAt), otherwise deliverableHash stops being reproducible.`,
    );
  }
  if (Number.isNaN(Date.parse(expiresAt))) {
    throw new InvalidSaExpiryError(`expires_at is not a parsable instant: ${expiresAt}`);
  }
  return expiresAt;
}

/** {@link buildSaBody} 的参数。 */
export interface BuildSaBodyParams {
  readonly caseId: string;
  /** 8183 jobId。bigint 或十进制字符串皆可，落盘统一为字符串（JSON 没有 bigint）。 */
  readonly jobId: bigint | string;
  /**
   * SA 有效期。**只接受确定性来源，刻意不接受 `Date`。**
   *
   * - `bigint`：链上 Job 的 `expiredAt`（Unix 秒）——**推荐路径**，
   *   直接传 `JobView.expiredAt`；它在 `createJob` 之后就固定不变。
   * - `string`：显式 ISO8601 字符串（fixture/测试用）。
   *
   * ## 为什么不收 `Date`
   *
   * `expires_at` 在 `deliverableHash` 的输入里（**必须在**：合约 §5 要求 SA 绑定有效期，
   * 不签它就等于让任何人改 JSON 续期而签名照样验过）。所以只要它带一丝墙上时钟，
   * "同样输入 → 同样 SA"就不成立，验证器验签与"可复算"的对外承诺一起塌。
   *
   * 而 `new Date(Date.now() + 7 * 24 * 3600 * 1000)` 是最自然的写法，
   * 光靠注释挡不住。**把 `Date` 从类型里去掉，这个错就编译不过。**
   * 需要"从现在起 N 天"的语义时，请在**创建 Job 时**算一次并落库/上链，
   * 之后一律从链上那个值取（那才是唯一真相）。
   */
  readonly expiresAt: bigint | string;
  readonly modulesUsed: readonly SaModuleUsed[];
  readonly legs: readonly SaLeg[];
  /** 本 SA 覆盖的 rubric 判定项数（验证器第 3 检按它对账）。 */
  readonly itemsCovered: number;
  /** 覆盖默认 `preview`。不传则由 `legs` 统计生成。 */
  readonly preview?: SaPreview;
}

/**
 * 组装 SA 正文（不含 `attestation`）。
 *
 * @param params - 案件绑定信息、Module 版本、已算出 condition 的腿
 * @returns SA 正文
 * @throws {SaWordingError} 正文命中禁用措辞
 */
export function buildSaBody(params: BuildSaBodyParams): SaBody {
  const body: SaBody = {
    case_id: params.caseId,
    sa_version: SA_VERSION,
    bound_to: {
      job_id: typeof params.jobId === "bigint" ? params.jobId.toString() : params.jobId,
      expires_at: saExpiresAt(params.expiresAt),
    },
    modules_used: params.modulesUsed,
    legs: params.legs,
    preview: params.preview ?? buildPreview(params.legs, params.itemsCovered),
  };
  assertNoForbiddenWording(body);
  return body;
}

/** {@link buildSettlementAuthorization} 的参数。 */
export interface BuildSettlementAuthorizationParams extends BuildSaBodyParams {
  /** 由 `OPERATOR_PRIVATE_KEY` 派生的账户。**不是**验证器密钥（合约 §5.1）。 */
  readonly account: LocalAccount;
  readonly chainId?: number;
  readonly signedAt?: Date;
}

/**
 * 组装并签名完整 SA。
 *
 * @param params - {@link BuildSaBodyParams} 加签名账户
 * @returns 可直接交付的 SA（`attestation.signature` 由运营密钥签发）
 * @throws {SaWordingError} 正文命中禁用措辞
 */
export async function buildSettlementAuthorization(
  params: BuildSettlementAuthorizationParams,
): Promise<SettlementAuthorization> {
  const body = buildSaBody(params);
  const attestation = await signSaAttestation({
    body,
    account: params.account,
    ...(params.chainId === undefined ? {} : { chainId: params.chainId }),
    ...(params.signedAt === undefined ? {} : { signedAt: params.signedAt }),
  });
  return { ...body, attestation };
}

export { buildPreview as buildSaPreview };
