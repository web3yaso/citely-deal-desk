/**
 * 服务身份、能力与定价常量——对外话术的**唯一出处**。
 *
 * 这里的每一句都会进 agent card 与服务索引，是别人判断"要不要调用"的依据，
 * 因此措辞必须与 README 的对外承诺逐字对齐，不许在别处各写一份。
 */

import type { ModuleId } from "@citely/chain";

/**
 * 免责声明。**逐字固定**：它同时出现在服务索引、agent card 与每个业务响应里，
 * 任何一处改动都会让"我们对外只说这一句"变成三句不同的话。
 */
export const DISCLAIMER = "输出为基于公开法源整理的检查项状态，不构成法律意见。";

export const AGENT_NAME = "Citely Deal Desk";

export const AGENT_SHORT_DESCRIPTION =
  "把一笔跨境付款的合规问题变成一份 Settlement Authorization：" +
  "按需向独立的合规 Module 供应商 x402 付费取证，由确定性规则引擎推导逐腿放款条件" +
  "（PASS / HOLD / ESCALATE），产出可验签的 EIP-712 条件证明，" +
  "由客户自己的钱包在放款前独立核验。";

export const AGENT_CATEGORY = "compliance";

export const AGENT_TAGS = [
  "compliance",
  "settlement-authorization",
  "x402",
  "erc-8004",
  "erc-8183",
  "cross-border-payments",
] as const;

export const AGENT_DOCS_PATH = "/";

export const REPOSITORY_URL = "https://github.com/web3yaso/citely-deal-desk";

/** 上游合规 Module 供应商（独立仓库、独立部署、独立钱包）。 */
export const UPSTREAM_MODULE_SERVICE_URL = "https://github.com/web3yaso/msb-agent";

/**
 * 可用的合规 Module 与其法域。
 *
 * Deal Desk 自己**不含法律知识库**——这四个 module 是向上游按次采购的，
 * card 里如实标注来源，不让人误以为是我们自有的能力。
 */
export const MODULE_JURISDICTIONS: Record<ModuleId, string> = {
  "us-msb": "United States",
  "uk-msb": "United Kingdom",
  "eu-msb": "European Union",
  "sg-msb": "Singapore",
};

/**
 * 对外声明的能力。写成结构化条目而不是一段散文，是为了让调用方能逐条核对，
 * 也让"我们没做的事"（如"不提供法律意见"）同样显式可见。
 */
export interface Capability {
  readonly id: string;
  readonly summary: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "case-adjudication",
    summary:
      "接收一笔交易（DealInput），拆成逐参与方的判定项，按需向合规 Module 付费取证，" +
      "返回带 EIP-712 签名的 Settlement Authorization。",
  },
  {
    id: "deterministic-conditions",
    summary:
      "逐腿放款条件 PASS / HOLD / ESCALATE 完全由确定性规则从 Module 检查结果推导；" +
      "语言模型只做编排与摘要，改不动任何一条判定。",
  },
  {
    id: "independent-verification",
    summary:
      "SA 由一个独立进程、独立密钥的验证器做三检（签名、Module 版本、交付物哈希）" +
      "后才在链上放行案件款。",
  },
  {
    id: "escrowed-case-fee",
    summary:
      "案件款托管在 ERC-8183 合约；Citely 只收案件服务费、只支出 Module 采购费，" +
      "付款目标恒为 SA 里的收款方，客户结算资金不进 Citely 地址。",
  },
] as const;

/** 案件请求体上限：256KB，与上游 msb-agent 的 check 端点一致。 */
export const MAX_CASE_BODY_BYTES = 256 * 1024;
