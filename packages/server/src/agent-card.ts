/**
 * ERC-8004 agent card：**对外身份的唯一出处**，8004 注册的 URI 指向它。
 *
 * 两条硬纪律：
 *
 * 1. **诚实**。card 要写清能力、定价、四个可用 module，并原样带上免责声明。
 *    Deal Desk 自己不含法律知识库，四个 module 是**向上游按次采购**的——
 *    card 里如实标注 `sourced_from`，不让人误以为是我们自有的能力。
 * 2. **不泄密**。card 是公开文档：不得出现任何私钥、内部服务地址
 *    （如 `VERIFIER_URL`）或令牌。`agent-card.test.ts` 用负向断言守这条。
 */

import { ARC_TESTNET_CHAIN_ID } from "@citely/chain";

import {
  AGENT_CATEGORY,
  AGENT_DOCS_PATH,
  AGENT_NAME,
  AGENT_SHORT_DESCRIPTION,
  AGENT_TAGS,
  CAPABILITIES,
  DISCLAIMER,
  MODULE_JURISDICTIONS,
  REPOSITORY_URL,
  UPSTREAM_MODULE_SERVICE_URL,
} from "./constants.js";

const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
const SERVICE_VERSION = "0.1.0";

export interface AgentCardInput {
  /** 公网基地址（已规范化，无尾斜杠）。 */
  readonly baseUrl: string;
  /** 案件端点报价（USDC，6 位小数字符串）。未收费时为 `null`。 */
  readonly priceUsdc: string | null;
  /** 案件款收款地址。未收费时为 `null`。 */
  readonly payTo: string | null;
  /** 链 ID。默认 Arc Testnet。 */
  readonly chainId?: number;
  /** ERC-8004 Agent ID；未注册时缺省。 */
  readonly agentId?: number;
  /** ERC-8004 Identity Registry 合约地址；未注册时缺省。 */
  readonly identityRegistry?: string;
}

export interface AgentRegistration {
  readonly agentId: number;
  /** CAIP-10 风格的注册表标识：`eip155:<chainId>:<address>`。 */
  readonly agentRegistry: string;
}

/**
 * 构造链上身份声明。
 *
 * **未完成链上注册时返回 `undefined`，不作空声明**——填一个占位 agentId
 * 等于对外宣称一个不存在的链上身份。
 *
 * @param input - agent card 输入
 * @returns 注册声明；未注册时 `undefined`
 */
export function buildAgentRegistration(
  input: AgentCardInput,
): { readonly registrations: readonly AgentRegistration[] } | undefined {
  if (input.agentId === undefined || input.identityRegistry === undefined) return undefined;
  const chainId = input.chainId ?? ARC_TESTNET_CHAIN_ID;
  return {
    registrations: [
      {
        agentId: input.agentId,
        agentRegistry: `eip155:${String(chainId)}:${input.identityRegistry.toLowerCase()}`,
      },
    ],
  };
}

function buildPricing(input: AgentCardInput): Record<string, unknown> {
  if (input.priceUsdc === null || input.payTo === null) {
    // 不收费时如实说"不收费"，不填一个假价格。
    return { model: "free", note: "本部署未开启 x402 收费（本地联调配置）" };
  }
  return {
    model: "x402-per-call",
    protocol: "x402",
    settlement_asset: "USDC",
    price_usdc: input.priceUsdc,
    pay_to: input.payTo,
    endpoint: `${input.baseUrl}/cases`,
  };
}

/**
 * 构造 ERC-8004 agent card。
 *
 * @param input - 基地址、定价与链上身份
 * @returns 可直接 JSON 序列化的 card
 */
export function buildAgentCard(input: AgentCardInput): Record<string, unknown> {
  const chainId = input.chainId ?? ARC_TESTNET_CHAIN_ID;
  const registration = buildAgentRegistration(input);
  const paid = input.priceUsdc !== null && input.payTo !== null;

  return {
    type: REGISTRATION_TYPE,
    name: AGENT_NAME,
    description: `${AGENT_SHORT_DESCRIPTION}${DISCLAIMER}`,
    category: AGENT_CATEGORY,
    tags: [...AGENT_TAGS],
    services: [
      { name: "web", endpoint: `${input.baseUrl}${AGENT_DOCS_PATH}`, version: SERVICE_VERSION },
      ...(paid
        ? [{ name: "x402", endpoint: `${input.baseUrl}/cases`, version: "x402/2" }]
        : []),
    ],
    x402Support: paid,
    active: true,
    supportedTrust: ["reputation"],
    ...(registration ?? {}),
    "x-citely": {
      chain_id: chainId,
      repository: REPOSITORY_URL,
      pricing: buildPricing(input),
      capabilities: CAPABILITIES.map((capability) => ({
        id: capability.id,
        summary: capability.summary,
      })),
      endpoints: {
        create_case: `${input.baseUrl}/cases`,
        read_case: `${input.baseUrl}/cases/{case_id}`,
        health: `${input.baseUrl}/health`,
      },
      /**
       * 四个可用 module。`sourced_from` 是诚实性要求的一部分：
       * 这些法域能力**不是 Deal Desk 自有的**，是按次向上游采购的。
       */
      modules: Object.entries(MODULE_JURISDICTIONS).map(([id, jurisdiction]) => ({
        id,
        jurisdiction,
        sourced_from: UPSTREAM_MODULE_SERVICE_URL,
        procurement: "x402-per-call",
      })),
      settlement_authorization: {
        signature_scheme: "EIP-712",
        conditions: ["PASS", "HOLD", "ESCALATE"],
        note:
          "SA 是条件证明，由钱包按自有预设策略核验执行，不是 Citely 的付款指令；" +
          "客户结算资金不进 Citely 地址。",
      },
      no_llm_in_decision_path: true,
      independent_verifier: {
        note: "SA 由独立进程、独立密钥的验证器三检后才在链上放行案件款。",
        checks: ["deliverable_signature", "module_attestation", "deliverable_hash"],
      },
    },
    disclaimer: DISCLAIMER,
  };
}
