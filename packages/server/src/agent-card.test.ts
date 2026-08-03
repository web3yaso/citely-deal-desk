import { describe, expect, it } from "vitest";

import { buildAgentCard, buildAgentRegistration } from "./agent-card.js";
import type { AgentCardInput } from "./agent-card.js";
import { DISCLAIMER } from "./constants.js";

const PAID: AgentCardInput = {
  baseUrl: "https://deal-desk.test",
  priceUsdc: "3.000000",
  payTo: "0x00000000000000000000000000000000000000A1",
};

const FREE: AgentCardInput = { baseUrl: "http://localhost:3000", priceUsdc: null, payTo: null };

describe("buildAgentRegistration", () => {
  it("未注册时返回 undefined，不作空声明", () => {
    expect(buildAgentRegistration(PAID)).toBeUndefined();
    expect(buildAgentRegistration({ ...PAID, agentId: 851_930 })).toBeUndefined();
    expect(
      buildAgentRegistration({ ...PAID, identityRegistry: "0x00000000000000000000000000000000000000B2" }),
    ).toBeUndefined();
  });

  it("已注册时给出 CAIP 风格标识且地址小写", () => {
    const registration = buildAgentRegistration({
      ...PAID,
      agentId: 851_930,
      identityRegistry: "0x00000000000000000000000000000000000000B2",
      chainId: 5_042_002,
    });
    expect(registration).toEqual({
      registrations: [
        {
          agentId: 851_930,
          agentRegistry: "eip155:5042002:0x00000000000000000000000000000000000000b2",
        },
      ],
    });
  });
});

describe("buildAgentCard", () => {
  it("带上免责声明", () => {
    const card = buildAgentCard(PAID);
    expect(card["disclaimer"]).toBe(DISCLAIMER);
    expect(String(card["description"])).toContain(DISCLAIMER);
  });

  it("收费时声明 x402 能力与定价", () => {
    const card = buildAgentCard(PAID);
    expect(card["x402Support"]).toBe(true);
    const citely = card["x-citely"] as Record<string, unknown>;
    expect(citely["pricing"]).toMatchObject({
      model: "x402-per-call",
      price_usdc: "3.000000",
      pay_to: PAID.payTo,
      endpoint: "https://deal-desk.test/cases",
    });
  });

  it("未收费时如实说明，不填假价格", () => {
    const card = buildAgentCard(FREE);
    expect(card["x402Support"]).toBe(false);
    const citely = card["x-citely"] as Record<string, unknown>;
    expect(citely["pricing"]).toMatchObject({ model: "free" });
    const services = card["services"] as { name: string }[];
    expect(services.some((service) => service.name === "x402")).toBe(false);
  });

  it("列出五个可用 module 并标注来自上游采购", () => {
    const citely = buildAgentCard(PAID)["x-citely"] as Record<string, unknown>;
    const modules = citely["modules"] as {
      id: string;
      jurisdiction: string;
      sourced_from: string;
    }[];
    expect(modules.map((module) => module.id).sort()).toEqual([
      "ae-msb",
      "eu-msb",
      "sg-msb",
      "uk-msb",
      "us-msb",
    ]);
    expect(modules.find((module) => module.id === "ae-msb")?.jurisdiction).toBe(
      "United Arab Emirates",
    );
    expect(modules.every((module) => module.sourced_from.includes("msb-agent"))).toBe(true);
  });

  it("声明能力清单与放款条件不由 LLM 决定", () => {
    const citely = buildAgentCard(PAID)["x-citely"] as Record<string, unknown>;
    expect((citely["capabilities"] as unknown[]).length).toBeGreaterThan(0);
    expect(citely["no_llm_in_decision_path"]).toBe(true);
    expect(citely["independent_verifier"]).toBeDefined();
  });

  it("端点地址全部基于给定基地址", () => {
    const citely = buildAgentCard(PAID)["x-citely"] as Record<string, unknown>;
    expect(citely["endpoints"]).toEqual({
      create_case: "https://deal-desk.test/cases",
      read_case: "https://deal-desk.test/cases/{case_id}",
      health: "https://deal-desk.test/health",
    });
  });

  it("SA 措辞不得出现 Citely 授权付款的说法", () => {
    const serialized = JSON.stringify(buildAgentCard(PAID));
    expect(serialized).not.toMatch(/Citely authorizes/i);
    expect(serialized).toContain("conditional proof");
    expect(serialized).toContain("not a payment instruction");
  });

  // card 是给国际化机器发现用的公开文档，正文一律英文。
  // 中文注释随便写，但**任何进入 JSON 的值**都不能带中文——
  // 这条会在有人再次顺手写中文文案时当场红。
  it("card 正文不含中文字符", () => {
    const serialized = JSON.stringify(buildAgentCard(PAID));
    const cjk = serialized.match(/[一-鿿]/gu);
    expect(cjk ?? []).toEqual([]);
  });

  // 负向断言：card 是公开文档，任何密钥/内部地址泄进来都必须当场红。
  it("不含私钥形状的字符串", () => {
    const serialized = JSON.stringify(
      buildAgentCard({
        ...PAID,
        agentId: 1,
        identityRegistry: "0x00000000000000000000000000000000000000B2",
      }),
    );
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  // image 必须跟着 baseUrl 走。写死域名的话本地联调的 card 会指向线上那张图，
  // 而且换部署地址后 card 会静默指向一个不存在的主机。
  it("image 由 baseUrl 拼出，不写死域名", () => {
    expect(buildAgentCard(PAID)["image"]).toBe("https://deal-desk.test/static/agent-icon.png");
    expect(buildAgentCard(FREE)["image"]).toBe("http://localhost:3000/static/agent-icon.png");
  });

  it("不含内部服务变量名或令牌字样", () => {
    const serialized = JSON.stringify(buildAgentCard(PAID));
    for (const forbidden of [
      "VERIFIER_URL",
      "VERIFIER_PRIVATE_KEY",
      "INTERNAL_SERVICE_TOKEN",
      "OPENAI_API_KEY",
      "OPERATOR_PRIVATE_KEY",
      "PROCUREMENT_PRIVATE_KEY",
      "MARKETPLACE_PRIVATE_KEY",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
