/**
 * 出口 4（解释性 gray → Review Job）真链验证。
 *
 * 出口 4 是"法律问题"：买数据没用，只能升级给人。该腿标 ESCALATE，随 SA 一起产出
 * **会谈卷宗**与 **Review Job 模板**；Review Job 本身是一个**独立的 8183 Job**，
 * 角色映射与主案件不同：
 *
 * | 8183 角色 | 谁 | 密钥 |
 * |---|---|---|
 * | `client` | **Marketplace**（委托人，注资） | `MARKETPLACE_PRIVATE_KEY` |
 * | `provider` | 接单评审的独立专家 | `REVIEW_EXPERT_PRIVATE_KEY` |
 * | `evaluator` | 裁定评审结果 | `VERIFIER_PRIVATE_KEY`（复用） |
 *
 * **`client` 必须是 Marketplace，不是 Citely 运营地址**（v2.3 §2.3 资金规划：
 * "专家的钱永远来自委托人"）。填成我方地址等于让 Citely 替客户付专家酬金——
 * 那是一条完全不同的、需要牌照讨论的业务，所以 preflight 把它列为独立断言。
 *
 * 用法：
 * ```
 * # 只做前置检查，一分钱不花（默认）
 * ARC_RPC_URL=https://arc-testnet.drpc.org \
 *   node --import tsx scripts/spike/exit4-review-job.ts
 *
 * # 真发交易（默认保证金 0.05 USDC）
 * ARC_RPC_URL=https://arc-testnet.drpc.org \
 *   node --import tsx scripts/spike/exit4-review-job.ts --live [--deposit 0.05]
 * ```
 *
 * **默认不花钱**与 `exit3-procurement.ts` 同一口径：真花钱的脚本，默认行为应该是
 * "告诉我会花多少"，`--live` 是那道必须由人按下的闸。
 *
 * ## 验证范围（别把本脚本读成比它更强的证据）
 *
 * - 真实的：五出口路由、升级材料组装（卷宗 + 模板）、角色映射、有效期下限、
 *   Review Job 的链上五步状态迁移、三个钱包的余额双向对账。
 * - **不真实的**：判定 verdict 与 Module 响应由 fixture 固定给出，未调 LLM、未付费采购
 *   （那两条链路分别由判定器回归与 `exit3-procurement.ts` 覆盖）。
 */

import {
  ENV_KEYS,
  loadDotEnvFile,
  optionalEnv,
  readAddress,
  readOptionalPrivateKey,
  type EnvSource,
} from "../../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../../packages/chain/src/config/redact.js";
import { formatUsdc } from "../../packages/chain/src/diagnostics.js";
import { ChainError } from "../../packages/chain/src/errors.js";
import { bytes32FromText } from "../../packages/chain/src/hashing.js";
import { InMemoryIdempotencyStore } from "../../packages/chain/src/idempotency-store.js";
import {
  createJobClient,
  DEMO_EXPIRY_SECONDS,
  expiryFromNow,
  MIN_EXPIRY_SECONDS,
  splitFees,
  ZERO_ADDRESS,
  type JobRoleWallets,
} from "../../packages/chain/src/job-client.js";
import type { JobClient, JobFeeRates } from "../../packages/chain/src/types/job.js";
import type { DealInput, ModuleResponse } from "../../packages/chain/src/types/module.js";
import type { Address, Hex } from "../../packages/chain/src/types/viem.js";
import { createArcPublicClient, createChainClients, type RpcConfig } from "../../packages/chain/src/wallet.js";
import { createJobRoleClients } from "../../packages/chain/src/wiring.js";
import { parseUsdcAmount } from "../../packages/chain/src/x402-client.js";
import type { AdjudicatedItem } from "../../packages/engine/src/adjudicator/rubric-run.js";
import type { ReviewJobTemplate } from "../../packages/engine/src/escalation/review-job.js";
import {
  buildCaseEscalation,
  intake,
  toRoutingSummaries,
} from "../../packages/engine/src/orchestrator/stages.js";
import { itemsNeedingEscalation, routeExit } from "../../packages/engine/src/routing/index.js";
import { loadRubric, type LoadedRubric } from "../../packages/engine/src/rubric/index.js";
import { canonicalBytes, canonicalJson } from "../../packages/engine/src/util/canonical.js";
import { sha256Hex0x } from "../../packages/engine/src/util/hash.js";
import { usdc6 } from "../../packages/engine/src/util/usdc6.js";

/** 演示友好的小额保证金：真链跑一次不该烧掉可观余额。 */
const DEFAULT_DEPOSIT_USDC = "0.05";

/** Review Job 有效期：复用演示缺省 10 分钟（链上下限是**严格大于** 5 分钟）。 */
const REVIEW_EXPIRY_SECONDS = DEMO_EXPIRY_SECONDS;

/**
 * 三个角色在 `--live` 段都要发交易，各自都得有 gas：0.01 原生币（= 10^16 wei）。
 *
 * 写成字面量而不是 `parseEther("0.01")`：`scripts/` 不是 workspace 包，解析不到
 * `viem`（见 `packages/chain/src/types/viem.ts` 的说明）。
 */
const MIN_NATIVE_FOR_GAS = 10n ** 16n;

/** 原生币小数位。Arc 的 gas 币是 USDC，但原生计数是 18 位。 */
const NATIVE_DECIMALS = 18n;

/** Arc Testnet 的 faucet；余额不足时直接把地址和它一起打出来。 */
const FAUCET_URL = "https://faucet.circle.com";

/** 本案触发出口 4 的判定项：MT-01 的 `confidence_rule` 明写"控制的法律边界有争议 → gray_interpretive"。 */
const ESCALATED_ITEM_ID = "MT-01";

/** 余额对账残差容差：Arc 上 gas 也从 USDC 余额扣，估不准的那一点点留在这里。 */
const RECONCILE_TOLERANCE = 1_000n;

/** 原生币 18 位小数 → USDC 6 位小数的换算因子（Arc 的 gas 币就是 USDC）。 */
const NATIVE_TO_USDC6 = 10n ** 12n;

const RUBRIC_PATH = new URL("../../rubrics/us-msb.json", import.meta.url).pathname;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function section(title: string): void {
  write(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

/** 断言并打印。失败即抛——真链脚本不许"看起来跑过了"。 */
function assert(label: string, ok: boolean, detail = ""): void {
  write(`  ${ok ? "✅" : "❌"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) throw new Error(`assertion failed: ${label}`);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** 一条检查结果。攒成数组一次性打印，才能"一次看全所有问题"。 */
export interface Check {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

function report(checks: readonly Check[]): void {
  for (const check of checks) assert(check.label, check.ok, check.detail);
}

/** 地址比较一律小写：EIP-55 校验和大小写不同不代表是两个地址。 */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 本文件是否作为入口被执行。
 *
 * 有它才能把纯函数拿去单测：sibling 脚本在模块顶层就 `await main()`，
 * 一 import 就会真连链。
 *
 * @param argvEntry - `process.argv[1]`
 * @param moduleUrl - `import.meta.url`
 */
export function isEntrypoint(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (argvEntry === undefined) return false;
  return moduleUrl.endsWith(argvEntry.replace(/\\/g, "/"));
}

/**
 * 触发解释性 gray 的案件：FBO 账户里"指令权算不算控制"是法律争议，不是数据缺口。
 *
 * 买再多数据也答不了这个问题——这正是出口 3 与出口 4 的分界。
 *
 * @param caseId - 案件 id，同时作为 `deal_id`
 */
export function interpretiveGrayDeal(caseId: string): DealInput {
  return {
    deal_id: caseId,
    parties: [
      { role: "payer", country: "US", state: "CA" },
      { role: "payee", country: "US", state: "NY" },
    ],
    activity: "money_transmission",
    amount_usdc: 48_000,
    monthly_volume_usdc: 1_900_000,
    evidence: {
      incorporation_country: "US",
      fincen_msb_registration: "registered",
      custody_model:
        "Funds rest in a bank-held FBO account; the platform issues payout instructions and the bank executes them.",
      compliance_note:
        "Counsel for the parties disagree on whether instruction authority over an FBO account amounts to control of the funds.",
    },
  };
}

/**
 * 判定结果 fixture：指定判定项判为 `gray_interpretive`，其余为确定结论。
 *
 * `source` 取自 rubric 原文而不是手写字符串——卷宗里的法源必须来自确定性数据。
 *
 * @param rubric - 已加载的 rubric
 * @param grayItemId - 被判为解释性 gray 的判定项 id
 */
export function fixtureAdjudications(
  rubric: LoadedRubric,
  grayItemId: string,
): readonly AdjudicatedItem[] {
  return rubric.rubric.items.map((item) => {
    const gray = item.id === grayItemId;
    return {
      item_id: item.id,
      verdict: gray ? ("gray_interpretive" as const) : ("confirmed_in_scope" as const),
      gray_type: gray ? ("interpretive" as const) : undefined,
      confidence: gray ? ("low" as const) : ("high" as const),
      risk_flags: [],
      source: item.source,
      // fixture 不是 cache 命中，也没有做过修复——如实标注，别让人误读成真跑过判定器。
      cacheHit: false,
      repairs: [],
    };
  });
}

/**
 * Module 响应 fixture。
 *
 * 卷宗只会用到 `module` / `version` / `evidence_hash` 三个字段（见
 * `orchestrator/stages.ts` 的 `buildCaseEscalation`），其余字段只为满足形状。
 * 本脚本**不验证 Module 判定本身**——那是 `exit3-procurement.ts` 的范围。
 *
 * @param caseId - 案件 id
 */
export function moduleResponseFixture(caseId: string): ModuleResponse {
  return {
    module: "us-msb",
    version: "2026.07.1",
    updated_at: "2026-07-01T00:00:00Z",
    maintainer_wallet: "0x76B05e0000000000000000000000000000000000",
    royalty_bps: 500,
    checks: [
      {
        id: "MT-01",
        result: "ESCALATE",
        basis: "manual_review",
        reason: "control over FBO-held funds is contested on the record",
        source: "31 CFR § 1010.100(ff)(5)(i)(A)",
      },
    ],
    overall: "ESCALATE",
    settlement_constraints: {
      module: "us-msb",
      module_version: "2026.07.1",
      deal_id: caseId,
      valid_until: "2026-12-31T00:00:00Z",
      blocked_check_ids: [],
      escalated_check_ids: ["MT-01"],
      // 确实被评估过（1 条 check 命中升级）；0 表示模块压根没评估这笔交易。
      evaluated_check_count: 1,
      evidence_hash: "11".repeat(32),
    },
    evidence_hash: "11".repeat(32),
    engine_version: "1.0.0",
    hash_scheme_version: "2",
    disclaimer: "Check-item statuses compiled from public legal sources; not legal advice.",
  };
}

/** {@link reviewJobTemplateChecks} 的期望值。 */
export interface ExpectedReviewRoles {
  /** Review Job 的委托人（8183 `client`）。 */
  readonly marketplace: Address;
  /** 接单评审的专家（8183 `provider`）。 */
  readonly expert: Address;
  /** 裁定方（8183 `evaluator`）。 */
  readonly verifier: Address;
  /** Citely 运营地址：`client` **不得**是它。 */
  readonly operator: Address;
  /** 将要传给 `createJob` 的 `expiredAt`（Unix 秒）。 */
  readonly expiredAt: bigint;
  /** 链上当前时刻（Unix 秒），用来算到期余量——别用本机时钟。 */
  readonly chainNow: bigint;
  /** 将要注资的保证金（最小单位）。 */
  readonly deposit: bigint;
}

/**
 * 逐项检查 Review Job 模板。**填错角色不会 revert，只会静默把钱付错人**，
 * 所以这些断言必须在花钱之前跑完。
 *
 * @param template - 组装出来的模板
 * @param expected - 期望的角色地址、到期时刻与保证金
 * @returns 逐条检查结果（`ok` 全为真才算通过）
 */
export function reviewJobTemplateChecks(
  template: ReviewJobTemplate,
  expected: ExpectedReviewRoles,
): readonly Check[] {
  const expiredAtUnix = Number(template.expired_at_unix);
  const margin = BigInt(template.expired_at_unix) - expected.chainNow;
  return [
    check("client 是 Marketplace（委托人注资）", sameAddress(template.client, expected.marketplace), template.client),
    check(
      "client **不是** Citely 运营地址（否则等于我方替客户付专家酬金）",
      !sameAddress(template.client, expected.operator),
      `运营地址 ${expected.operator}`,
    ),
    check("provider 是专家钱包", sameAddress(template.provider, expected.expert), template.provider),
    check(
      "provider **不是** Citely 运营地址（否则等于我方评审我方自己的判定）",
      !sameAddress(template.provider, expected.operator),
      `运营地址 ${expected.operator}`,
    ),
    check("evaluator 是验证器钱包", sameAddress(template.evaluator, expected.verifier), template.evaluator),
    check(
      "expired_at_unix 与将传给 createJob 的值逐字一致",
      template.expired_at_unix === expected.expiredAt.toString(),
      `模板 ${template.expired_at_unix} / createJob ${expected.expiredAt.toString()}`,
    ),
    check(
      "expires_at 与 expired_at_unix 指向同一时刻",
      Date.parse(template.expires_at) / 1000 === expiredAtUnix,
      template.expires_at,
    ),
    check(
      `到期余量 > ${MIN_EXPIRY_SECONDS.toString()} 秒（链上 ExpiryTooShort 下限）`,
      margin > MIN_EXPIRY_SECONDS,
      `余量 ${margin.toString()} 秒（链上时间 ${expected.chainNow.toString()}）`,
    ),
    check(
      "deposit_nominal 与将要注资的金额一致",
      template.deposit_nominal === expected.deposit.toString(),
      `${formatUsdc(BigInt(template.deposit_nominal))} USDC`,
    ),
    check("hook 为零地址（我方不用 hook）", sameAddress(template.hook, ZERO_ADDRESS), template.hook),
  ];
}

function check(label: string, ok: boolean, detail = ""): Check {
  return { label, ok, detail };
}

/**
 * 两份模板是否逐字节相同——**"expiresAt 不是 `new Date()`"的落地判据**。
 *
 * 同一锚点组装两次必须完全一样；只要哪里偷偷读了墙上时钟，这里就会不等
 * （SA 的可复现性正是被这种地方毁掉的，我们为此修过一轮）。
 *
 * @param a - 第一次组装的模板
 * @param b - 第二次组装的模板
 */
export function isSameTemplate(a: ReviewJobTemplate, b: ReviewJobTemplate): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** 一个钱包在 `--live` 段的资金要求。 */
export interface WalletFunding {
  readonly role: string;
  readonly address: Address;
  /** 原生币余额（wei）。Arc 上 gas 就是 USDC。 */
  readonly native: bigint;
  /** 钱包 USDC（ERC-20，6 位小数）余额。 */
  readonly token: bigint;
  readonly minNative: bigint;
  /** 需要付出去的 USDC；只有出资方（Marketplace）不为 0。 */
  readonly minToken: bigint;
}

/**
 * 三个钱包的资金体检。
 *
 * 专家钱包的 gas 单列一条：`setBudget` 在参考实现里
 * `if (msg.sender != job.provider) revert Unauthorized()`——**只有专家能调**，
 * 所以它必须自己发交易、必须有 gas。这与 `diagnostics.ts` 里
 * `REVIEW_EXPERT_GAS_NOTE` 说的"通常不需要 gas"不矛盾：那说的是不跑 `--live`
 * 的常态（专家只是 `createJob` 参数里的收款方）。
 *
 * @param wallets - 三个角色的余额与门槛
 * @returns 逐条检查结果
 */
export function walletFundingChecks(wallets: readonly WalletFunding[]): readonly Check[] {
  return wallets.flatMap((w) => {
    const nativeOk = w.native >= w.minNative;
    const lines = [
      check(
        `${w.role} 有 gas（原生币 ≥ ${formatNative(w.minNative)}）`,
        nativeOk,
        `${w.address} 原生 ${formatNative(w.native)}${nativeOk ? "" : `，去 ${FAUCET_URL} 领`}`,
      ),
    ];
    if (w.minToken === 0n) return lines;
    const tokenOk = w.token >= w.minToken;
    return [
      ...lines,
      check(
        `${w.role} 钱包 USDC ≥ ${formatUsdc(w.minToken)}（保证金由它出）`,
        tokenOk,
        `${w.address} 钱包 USDC ${formatUsdc(w.token)}${tokenOk ? "" : `，去 ${FAUCET_URL} 领`}`,
      ),
    ];
  });
}

/** 一次 Review Job 收口后，三个角色的 USDC 预期净变化（不含 gas）。 */
export interface SettlementExpectation {
  /** 委托人：付出保证金。 */
  readonly client: bigint;
  /** 专家：收到净额。 */
  readonly provider: bigint;
  /** 裁定方：收到评审费。 */
  readonly evaluator: bigint;
}

/**
 * 按链上费率算三方预期变化。费率必须**读自链上**，账本不许硬编码。
 *
 * @param deposit - 保证金（最小单位）
 * @param fees - 链上读到的费率
 */
export function settlementExpectation(deposit: bigint, fees: JobFeeRates): SettlementExpectation {
  const { evaluatorFee, net } = splitFees(deposit, fees);
  return { client: -deposit, provider: net, evaluator: evaluatorFee };
}

/** 专家提交的评审结论（正文链下，链上只有它的哈希——不变量 4）。 */
export interface ReviewOutcome {
  readonly case_id: string;
  readonly reviewed_item_ids: readonly string[];
  /** 卷宗哈希：把评审结论与它所依据的那份卷宗绑定。 */
  readonly briefing_pack_hash: string;
  /** 措辞纪律：陈述复核已完成，不表达任何放款授权。 */
  readonly reviewer_note: string;
}

/**
 * 评审结论 → `submit` 的 `deliverableHash`。
 *
 * 用与 SA 同一套规范化实现，所以裁定方拿到正文能自己复算比对。
 *
 * @param outcome - 评审结论正文
 */
export function reviewDeliverableHash(outcome: ReviewOutcome): Hex {
  return sha256Hex0x(canonicalBytes(outcome));
}

/** 原生币（18 位）折算成 USDC 最小单位（6 位）：Arc 的 gas 币就是 USDC。 */
export function nativeToUsdc6(wei: bigint): bigint {
  return wei / NATIVE_TO_USDC6;
}

/**
 * 原生币（18 位小数）渲染成人读字符串。
 *
 * 自己写而不是用 `formatEther`：脚本解析不到 `viem`（见 `types/viem.ts`）。
 *
 * @param wei - 原生币最小单位
 */
export function formatNative(wei: bigint): string {
  const one = 10n ** NATIVE_DECIMALS;
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const fraction = (abs % one).toString().padStart(Number(NATIVE_DECIMALS), "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${(abs / one).toString()}${fraction === "" ? "" : `.${fraction}`}`;
}

function readExpertKey(env: EnvSource): Hex {
  const key = readOptionalPrivateKey(env, ENV_KEYS.reviewExpertKey);
  if (key === undefined) {
    throw new ChainError(
      `出口 4 的 Review Job 需要 ${ENV_KEYS.reviewExpertKey}：它是 Review Job 的 8183 ` +
        "provider（接单评审、收酬金的独立专家），不能复用我方任何一把钥；填法见 .env.example",
    );
  }
  return key;
}

function resolveRpc(env: EnvSource): RpcConfig {
  const primaryUrl = optionalEnv(env, ENV_KEYS.rpcUrl);
  if (primaryUrl === undefined) {
    throw new ChainError(`未设置 ${ENV_KEYS.rpcUrl}`);
  }
  const fallbackUrl = optionalEnv(env, ENV_KEYS.rpcUrlFallback);
  return fallbackUrl === undefined ? { primaryUrl } : { primaryUrl, fallbackUrl };
}

/** 只读 client 的类型。写成 `ReturnType` 是因为脚本解析不到 `viem` 的类型（见 `types/viem.ts`）。 */
type ArcPublicClient = ReturnType<typeof createArcPublicClient>;

/** `balanceOf` 的最小 ABI：脚本引不到 viem 的 `erc20Abi`，与 exit1/exit5 同一写法。 */
const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function usdcBalance(
  publicClient: ArcPublicClient,
  usdc: Address,
  owner: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: usdc,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** 三个角色的余额快照，跑前跑后各取一次做双向对账。 */
async function snapshotBalances(
  publicClient: ArcPublicClient,
  usdc: Address,
  addresses: readonly Address[],
): Promise<readonly bigint[]> {
  return Promise.all(addresses.map(async (a) => usdcBalance(publicClient, usdc, a)));
}

/** 累计若干笔交易的 gas（wei）。Arc 上它也从 USDC 余额里扣，所以对账要减掉。 */
async function gasSpent(publicClient: ArcPublicClient, hashes: readonly Hex[]): Promise<bigint> {
  const receipts = await Promise.all(
    hashes.map(async (hash) => publicClient.getTransactionReceipt({ hash })),
  );
  return receipts.reduce((sum, r) => sum + r.gasUsed * r.effectiveGasPrice, 0n);
}

/** 本次运行的全部句柄，攒成一个对象免得每个函数传七八个参数。 */
interface Context {
  readonly publicClient: ArcPublicClient;
  readonly job: JobClient;
  readonly usdc: Address;
  readonly marketplace: Address;
  readonly expert: Address;
  readonly verifier: Address;
  readonly operator: Address;
  readonly deposit: bigint;
  readonly caseId: string;
}

function createContext(env: EnvSource, deposit: bigint, caseId: string): Context {
  const rpc = resolveRpc(env);
  const publicClient = createArcPublicClient(rpc);
  // 主案件那套角色映射：这里只取它的 client（Marketplace）、evaluator（验证器）
  // 与 provider 的**地址**（Citely 运营地址，用于"模板的 client 不是它"那条断言）。
  const main = createJobRoleClients(env, rpc);
  // ⚠️ `WalletRole` 里没有"评审专家"这一档，这里借用 `"operator"` 标签——它只影响
  // 私钥派生失败时的错误前缀，脚本各处一律以 expert 命名。**别据此认为专家=运营钱包**：
  // 两把钥物理分离，下面 assertDistinctWallets 也会拦住它们相同的情况。
  const expert = createChainClients("operator", readExpertKey(env), rpc);
  const wallets: JobRoleWallets = {
    client: main.client.walletClient,
    provider: expert.walletClient,
    evaluator: main.evaluator.walletClient,
  };
  const usdc = readAddress(env, ENV_KEYS.usdc, "Arc Testnet USDC");
  return {
    publicClient,
    usdc,
    job: createJobClient({
      jobContract: readAddress(env, ENV_KEYS.jobContract, "8183 合约地址"),
      usdc,
      publicClient,
      wallets,
      store: new InMemoryIdempotencyStore(),
    }),
    marketplace: main.client.address,
    expert: expert.address,
    verifier: main.evaluator.address,
    operator: main.provider.address,
    deposit,
    caseId,
  };
}

/** preflight 的产物：live 段要直接用它们，保证"验过的就是发出去的那一份"。 */
interface Preflight {
  readonly template: ReviewJobTemplate;
  readonly briefingPackHash: string;
  readonly escalatedItemIds: readonly string[];
  readonly expiredAt: bigint;
}

/** ① 路由：解释性 gray → 出口 4。 */
function preflightRouting(rubric: LoadedRubric, caseId: string): readonly string[] {
  section("① 路由：解释性 gray → 出口 4");
  const deal = interpretiveGrayDeal(caseId);
  const adjudicated = fixtureAdjudications(rubric, ESCALATED_ITEM_ID);
  // procured=true：出口 4 的定义里"买过仍未消解"的数据缺口也要升级，这里没有 gray_data，
  // 传 true 只是与编排主线（判定前已采购）保持同一口径。
  const routingInput = {
    intake: "ok" as const,
    expired: false,
    adjudications: toRoutingSummaries(adjudicated, true),
  };
  const decision = routeExit(routingInput);
  write(`  案件：${deal.deal_id}（FBO 账户的"指令权是否等于控制"存在法律争议）`);
  write(`  decision=${decision.exit} chainAction=${decision.chainAction} actor=${decision.actor}`);
  assert("路由到 interpretive_gray（出口 4）", decision.exit === "interpretive_gray");
  assert("出口 4 随 SA 一起 submit", decision.chainAction === "submit" && decision.actor === "operator");
  const escalated = itemsNeedingEscalation(routingInput).map((i) => i.item_id);
  assert(
    "升级清单命中且只命中解释性 gray 判定项",
    escalated.length === 1 && escalated[0] === ESCALATED_ITEM_ID,
    escalated.join(","),
  );
  return escalated;
}

/** ② 升级材料：会谈卷宗 + Review Job 模板。 */
function preflightEscalation(
  ctx: Context,
  rubric: LoadedRubric,
  escalatedItemIds: readonly string[],
  expiredAt: bigint,
  chainNow: bigint,
): Preflight {
  section("② 升级材料：会谈卷宗 + Review Job 模板");
  const build = (): ReturnType<typeof buildCaseEscalation> =>
    buildCaseEscalation({
      caseId: ctx.caseId,
      rubric,
      moduleResponse: moduleResponseFixture(ctx.caseId),
      facts: intake(interpretiveGrayDeal(ctx.caseId)),
      items: fixtureAdjudications(rubric, ESCALATED_ITEM_ID),
      escalatedItemIds,
      config: {
        client: ctx.marketplace,
        provider: ctx.expert,
        evaluator: ctx.verifier,
        // **不是 `new Date()`**：由链上锚定的 expiredAt 回算，模板与 createJob 同一个值。
        expiresAt: new Date(Number(expiredAt) * 1000),
        deposit: usdc6(ctx.deposit),
      },
    });

  const bundle = build();
  const template = bundle.escalation.review_job_template;
  write(`  卷宗判定项 ${bundle.briefingPack.facts.items.map((i) => i.item_id).join(",")}`);
  write(`  卷宗哈希 ${bundle.escalation.briefing_pack_hash}`);
  write(`  模板 description：${template.description}`);
  report(
    reviewJobTemplateChecks(template, {
      marketplace: ctx.marketplace,
      expert: ctx.expert,
      verifier: ctx.verifier,
      operator: ctx.operator,
      expiredAt,
      chainNow,
      deposit: ctx.deposit,
    }),
  );
  assert(
    "同一锚点两次组装逐字相同（expiresAt 没有偷读墙上时钟）",
    isSameTemplate(template, build().escalation.review_job_template),
  );
  return {
    template,
    briefingPackHash: bundle.escalation.briefing_pack_hash,
    escalatedItemIds,
    expiredAt,
  };
}

/** ③ 三个钱包的资金体检。 */
async function preflightBalances(ctx: Context): Promise<void> {
  section("③ 钱包资金体检");
  const roles = [
    { role: "Marketplace（client，注资）", address: ctx.marketplace, minToken: ctx.deposit },
    { role: "专家（provider，setBudget/submit 要自己发交易）", address: ctx.expert, minToken: 0n },
    { role: "验证器（evaluator，complete）", address: ctx.verifier, minToken: 0n },
  ] as const;
  const wallets: WalletFunding[] = [];
  for (const r of roles) {
    wallets.push({
      role: r.role,
      address: r.address,
      native: await ctx.publicClient.getBalance({ address: r.address }),
      token: await usdcBalance(ctx.publicClient, ctx.usdc, r.address),
      minNative: MIN_NATIVE_FOR_GAS,
      minToken: r.minToken,
    });
  }
  report(walletFundingChecks(wallets));
}

async function runPreflight(ctx: Context): Promise<Preflight> {
  const rubric = loadRubric(RUBRIC_PATH);
  const escalated = preflightRouting(rubric, ctx.caseId);
  // 有效期锚在**链上时间**上：本机时钟与出块时间能差好几秒，贴着下限传必然翻车。
  const { timestamp: chainNow } = await ctx.publicClient.getBlock({ blockTag: "latest" });
  const expiredAt = expiryFromNow(REVIEW_EXPIRY_SECONDS, chainNow);
  const preflight = preflightEscalation(ctx, rubric, escalated, expiredAt, chainNow);
  await preflightBalances(ctx);
  return preflight;
}

/** `--live` 段：Review Job 的五步链上状态迁移。 */
async function runLive(ctx: Context, preflight: Preflight): Promise<void> {
  section("④ 真链执行：Review Job 五步");
  const before = await snapshotBalances(ctx.publicClient, ctx.usdc, [
    ctx.marketplace,
    ctx.expert,
    ctx.verifier,
  ]);

  const created = await ctx.job.createJob({
    provider: ctx.expert,
    evaluator: ctx.verifier,
    expiredAt: preflight.expiredAt,
    description: preflight.template.description,
    caseId: ctx.caseId,
  });
  write(`  [1/5] createJob（Marketplace）jobId=${created.jobId.toString()} tx=${created.txHash}`);
  assert("createJob 后为 open", (await ctx.job.getJobState(created.jobId)) === "open");

  // setBudget 只有 provider 能调（参考实现 `msg.sender != job.provider → Unauthorized`），
  // 这就是专家钱包必须有 gas 的原因。
  const budgetTx = await ctx.job.setBudget(created.jobId, ctx.deposit);
  write(`  [2/5] setBudget（专家，只有 provider 能调）${formatUsdc(ctx.deposit)} USDC tx=${budgetTx}`);
  assert(
    "链上 budget 等于模板里的保证金",
    (await ctx.job.getJob(created.jobId)).budget === ctx.deposit,
  );

  const fundTx = await ctx.job.fund(created.jobId, ctx.deposit);
  write(`  [3/5] approve+fund（Marketplace 出资）tx=${fundTx}`);
  assert("fund 后为 funded", (await ctx.job.getJobState(created.jobId)) === "funded");

  const submitTx = await submitReview(ctx, preflight, created.jobId);
  assert("submit 后为 submitted", (await ctx.job.getJobState(created.jobId)) === "submitted");

  const completeTx = await ctx.job.complete(
    created.jobId,
    bytes32FromText(`${ctx.caseId}:review-accepted`),
  );
  write(`  [5/5] complete（验证器裁定）tx=${completeTx}`);
  assert("complete 后为 completed", (await ctx.job.getJobState(created.jobId)) === "completed");

  await reconcile(ctx, before, [
    [created.txHash, fundTx],
    [budgetTx, submitTx],
    [completeTx],
  ]);
  section("出口 4 验证完成");
  write(`  jobId=${created.jobId.toString()} 保证金 ${formatUsdc(ctx.deposit)} USDC 已付给专家\n`);
}

/** 专家提交评审结论：正文链下，链上只有哈希。 */
async function submitReview(ctx: Context, preflight: Preflight, jobId: bigint): Promise<Hex> {
  const outcome: ReviewOutcome = {
    case_id: ctx.caseId,
    reviewed_item_ids: preflight.escalatedItemIds,
    briefing_pack_hash: preflight.briefingPackHash,
    reviewer_note:
      "Interpretive review completed; item statuses are compiled from public legal sources and do not constitute legal advice.",
  };
  const hash = reviewDeliverableHash(outcome);
  const tx = await ctx.job.submit(jobId, hash);
  write(`  [4/5] submit（专家）deliverableHash=${hash} tx=${tx}`);
  return tx;
}

/** 对账表的一行：跑前跑后差额 vs（结算预期 − 该角色自付的 gas）。 */
function reconcileRow(
  role: string,
  amounts: { readonly before: bigint; readonly after: bigint; readonly expect: bigint; readonly gasWei: bigint },
): void {
  const delta = amounts.after - amounts.before;
  const gasUsdc = nativeToUsdc6(amounts.gasWei);
  const residual = delta - (amounts.expect - gasUsdc);
  write(
    `  ${role}：${formatUsdc(amounts.before)} → ${formatUsdc(amounts.after)}` +
      `（差额 ${formatUsdc(delta)}，结算预期 ${formatUsdc(amounts.expect)}，` +
      `gas ${formatUsdc(gasUsdc)}，残差 ${formatUsdc(residual)}）`,
  );
  if (residual > RECONCILE_TOLERANCE || residual < -RECONCILE_TOLERANCE) {
    // 不直接判失败：Arc 上 gas 也从 USDC 余额扣，本脚本的折算与 Marketplace 那笔
    // approve（txHash 不经 job-client 返回，gas 统计不到）都可能造成残差；
    // 但**必须人工复核**后再写进运行日志。
    write(`  ⚠️ ${role} 残差超出容差 ${formatUsdc(RECONCILE_TOLERANCE)}，请人工复核后再记录`);
  }
}

/**
 * 余额双向对账。
 *
 * 只信"链上状态迁移成功"是不够的——钱有没有到专家手上，只有余额差能回答。
 */
async function reconcile(
  ctx: Context,
  before: readonly bigint[],
  txsByRole: readonly (readonly Hex[])[],
): Promise<void> {
  section("⑤ 余额双向对账");
  const fees = await ctx.job.getFeeRates();
  const expected = settlementExpectation(ctx.deposit, fees);
  const addresses = [ctx.marketplace, ctx.expert, ctx.verifier];
  const after = await snapshotBalances(ctx.publicClient, ctx.usdc, addresses);
  const gas = await Promise.all(txsByRole.map(async (txs) => gasSpent(ctx.publicClient, txs)));
  write(
    `  链上费率 platform=${fees.platformFeeBP.toString()}bp evaluator=${fees.evaluatorFeeBP.toString()}bp`,
  );

  const roles = [
    { role: "Marketplace（client）", expect: expected.client },
    { role: "专家（provider）", expect: expected.provider },
    { role: "验证器（evaluator）", expect: expected.evaluator },
  ] as const;
  roles.forEach((row, i) => {
    // noUncheckedIndexedAccess 下索引取值可能是 undefined；三个数组等长由本函数自己保证。
    reconcileRow(row.role, {
      before: before[i] ?? 0n,
      after: after[i] ?? 0n,
      expect: row.expect,
      gasWei: gas[i] ?? 0n,
    });
  });
  assert("保证金确实到了专家手上（专家 USDC 净增）", (after[1] ?? 0n) > (before[1] ?? 0n));
  assert("委托人确实出了钱（Marketplace USDC 净减）", (after[0] ?? 0n) < (before[0] ?? 0n));
}

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../../.env", import.meta.url).pathname);
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const deposit = parseUsdcAmount(flagValue(argv, "--deposit") ?? DEFAULT_DEPOSIT_USDC);
  const caseId = `exit4-${String(Date.now())}`;

  write(`\n=== 出口 4 真链验证（${live ? "LIVE：会真发交易" : "PREFLIGHT：不花钱"}）===`);
  write("  验证范围：路由、升级材料组装、角色映射、有效期下限、五步状态迁移、余额对账。");
  write("  **不在范围内**：判定 verdict 与 Module 响应由 fixture 给出（未调 LLM、未付费采购）。");

  const ctx = createContext(process.env, deposit, caseId);
  const preflight = await runPreflight(ctx);

  if (!live) {
    section("PREFLIGHT 结束");
    write(`  下一步会花费：${formatUsdc(deposit)} USDC 保证金（Marketplace 出，最终归专家）`);
    write("               + 5 笔交易的 gas（Marketplace 2 笔、专家 2 笔、验证器 1 笔）");
    write("  确认无误后加 --live 真实执行。");
    return;
  }
  await runLive(ctx, preflight);
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(`EXIT4 FAILED: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
