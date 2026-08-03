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
export const DISCLAIMER =
  "Results are compliance check statuses compiled from public legal sources. Not legal advice.";

export const AGENT_NAME = "Citely Deal Desk";

export const AGENT_SHORT_DESCRIPTION =
  "Tells you whether a cross-border payment can be released, and on what conditions. " +
  "Send the details of a deal; get back a signed document saying, for each recipient, " +
  "whether to pay, hold, or send it to a human. Your own wallet checks that document " +
  "before any money moves — we never touch your funds.";

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

/**
 * agent 图标的公开路径。**必须是路径而不是完整 URL**：card 里的 `image` 由
 * `baseUrl + 这个路径` 拼出，写死域名会让本地联调的 card 指向线上资源。
 *
 * 路径与上游 msb-agent 一致（`/static/agent-icon.png`），
 * 让两个 agent 的 card 在同一个索引里长得一样。
 */
export const AGENT_IMAGE_PATH = "/static/agent-icon.png";

export const REPOSITORY_URL = "https://github.com/web3yaso/citely-deal-desk";

/** 上游合规 Module 供应商（独立仓库、独立部署、独立钱包）。 */
export const UPSTREAM_MODULE_SERVICE_URL = "https://github.com/web3yaso/msb-agent";

/**
 * 可用的合规 Module 与其法域。
 *
 * Deal Desk 自己**不含法律知识库**——这五个 module 是向上游按次采购的，
 * card 里如实标注来源，不让人误以为是我们自有的能力。
 */
export const MODULE_JURISDICTIONS: Record<ModuleId, string> = {
  "us-msb": "United States",
  "uk-msb": "United Kingdom",
  "eu-msb": "European Union",
  "sg-msb": "Singapore",
  "ae-msb": "United Arab Emirates",
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
      "Send us a deal — who is paying whom, from which countries, for what. " +
      "We check each recipient against compliance rules and return a signed document " +
      "with a clear answer for each one.",
  },
  {
    id: "deterministic-conditions",
    summary:
      "Every pay / hold / escalate decision comes from rules, not from an AI model. " +
      "The model helps organise the work and write summaries; it cannot change a single verdict.",
  },
  {
    // ⚠️ 措辞与部署形态必须一致。当前 VERIFIER_MODE=in-process，验证器与主服务同进程、
    // 同密钥空间——所以这里**不能**说 "running on its own, with its own key"。
    // 拆成独立服务后（代码缺口见 upstream 文档与 JobRoleWallets），再把这句改回去。
    id: "independent-verification",
    summary:
      "Before any money is released, a checker confirms the document is genuine, current, " +
      "and complete — signed by one key and verified against another, so it is never " +
      "self-attested. (This deployment runs that checker in the same process; " +
      "separating it into its own service is in progress.)",
  },
  {
    id: "escrowed-case-fee",
    summary:
      "Our fee sits in escrow until the work is verified. Your settlement funds stay in your " +
      "own wallet the whole time and are only ever sent to the recipients named in the document.",
  },
] as const;

/** 案件请求体上限：256KB，与上游 msb-agent 的 check 端点一致。 */
export const MAX_CASE_BODY_BYTES = 256 * 1024;
