import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_ENV_VARS,
  loadServerConfig,
  loadVerifierServiceConfig,
  sellerPriceUsdc,
  ServerConfigError,
} from "./config.js";

/** 去掉一个字段的浅拷贝。比解构丢弃更直白，也不触发未使用变量规则。 */
function without<T extends object>(source: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...source };
  delete copy[key];
  return copy;
}

const OPERATOR = `0x${"1".repeat(64)}`;
const MARKETPLACE = `0x${"2".repeat(64)}`;
const PROCUREMENT = `0x${"3".repeat(64)}`;
const VERIFIER_KEY = `0x${"4".repeat(64)}`;

const ADDRESS_A = "0x0000000000000000000000000000000000000A11";
const ADDRESS_B = "0x0000000000000000000000000000000000000B22";
const ADDRESS_C = "0x0000000000000000000000000000000000000C33";

/** 不收费 + 进程内验证器的最小可用环境。 */
const BASE_ENV: Record<string, string> = {
  X402_SELL_MODE: "off",
  VERIFIER_MODE: "in-process",
  ARC_CHAIN_ID: "5042002",
  JOB_CONTRACT_ADDRESS: ADDRESS_A,
  USDC_ADDRESS: ADDRESS_B,
  OPERATOR_PRIVATE_KEY: OPERATOR,
  MARKETPLACE_PRIVATE_KEY: MARKETPLACE,
  PROCUREMENT_PRIVATE_KEY: PROCUREMENT,
  VERIFIER_ADDRESS: ADDRESS_C,
  MSB_AGENT_BASE_URL: "https://msb-agent.test",
  CASE_BUDGET_USDC: "3.00",
  MODULE_PRICE_USDC: "0.80",
  // 仓库里真实存在的一份 rubric；相对路径按仓库根解析，与 cwd 无关。
  RUBRIC_PATH: "rubrics/us-msb.json",
};

/** 记录型 Proxy：读了哪些键是可观测的，"不读某个键"因此可以被断言。 */
function recordingEnv(source: Record<string, string>): {
  env: Record<string, string | undefined>;
  reads: string[];
} {
  const reads: string[] = [];
  const env = new Proxy(source, {
    get: (target, property) => {
      if (typeof property === "string") reads.push(property);
      return Reflect.get(target, property) as string | undefined;
    },
  }) as Record<string, string | undefined>;
  return { env, reads };
}

describe("loadServerConfig", () => {
  it("读出最小可用配置", () => {
    const config = loadServerConfig(BASE_ENV);
    expect(config.port).toBe(3000);
    expect(config.seller.mode).toBe("off");
    expect(config.verifier).toEqual({ mode: "in-process" });
    expect(config.caseBudget).toBe(3_000_000n);
    expect(config.modulePrice).toBe(800_000n);
    expect(config.moduleId).toBe("us-msb");
  });

  // 这条是 T2 的核心断言：主服务进程**根本不去读**验证器私钥。
  it("绝不读取 VERIFIER_PRIVATE_KEY", () => {
    const { env, reads } = recordingEnv({ ...BASE_ENV, VERIFIER_PRIVATE_KEY: VERIFIER_KEY });
    loadServerConfig(env);
    for (const forbidden of FORBIDDEN_ENV_VARS) {
      expect(reads).not.toContain(forbidden);
    }
  });

  it("禁读清单里就是验证器那把钥匙", () => {
    expect(FORBIDDEN_ENV_VARS).toContain("VERIFIER_PRIVATE_KEY");
  });

  it("未配 VERIFIER_URL 又没显式声明 in-process 时拒绝启动", () => {
    const env = without(BASE_ENV, "VERIFIER_MODE");
    expect(() => loadServerConfig(env)).toThrow(ServerConfigError);
    expect(() => loadServerConfig(env)).toThrow(/VERIFIER_URL/);
  });

  it("配了 VERIFIER_URL 则走远端模式并要求令牌", () => {
    const env = { ...BASE_ENV, VERIFIER_URL: "https://verifier.internal" };
    expect(() => loadServerConfig(env)).toThrow(/INTERNAL_SERVICE_TOKEN/);

    const config = loadServerConfig({ ...env, INTERNAL_SERVICE_TOKEN: "token-value" });
    expect(config.verifier).toEqual({
      mode: "remote",
      url: "https://verifier.internal",
      token: "token-value",
    });
  });

  it("收费模式缺公网地址时拒绝启动", () => {
    const env = {
      ...BASE_ENV,
      X402_SELL_MODE: "x402-arc-testnet",
      X402_SELL_PAY_TO: ADDRESS_A,
      X402_FACILITATOR_URL: "https://facilitator.test",
    };
    expect(() => loadServerConfig(env)).toThrow();
  });

  it("缺必需地址时响亮失败", () => {
    const env = without(BASE_ENV, "JOB_CONTRACT_ADDRESS");
    expect(() => loadServerConfig(env)).toThrow(/JOB_CONTRACT_ADDRESS/);
  });

  it("案件费不是合法 USDC 金额时报错且不回显值", () => {
    const env = { ...BASE_ENV, CASE_BUDGET_USDC: "3.0000001" };
    expect(() => loadServerConfig(env)).toThrow(ServerConfigError);
    expect(() => loadServerConfig(env)).toThrow(/CASE_BUDGET_USDC/);
    try {
      loadServerConfig(env);
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain("3.0000001");
    }
  });

  it("ERC8004 Agent ID 非整数时报错", () => {
    expect(() => loadServerConfig({ ...BASE_ENV, ERC8004_AGENT_ID: "abc" })).toThrow(
      /ERC8004_AGENT_ID/,
    );
  });

  it("未注册 8004 时 agentId 为 undefined，不填占位值", () => {
    expect(loadServerConfig(BASE_ENV).agentId).toBeUndefined();
    expect(loadServerConfig(BASE_ENV).identityRegistry).toBeUndefined();
  });

  it("PORT 可覆盖", () => {
    expect(loadServerConfig({ ...BASE_ENV, PORT: "8080" }).port).toBe(8080);
  });

  it("未设 MODULE_ID 时回落 us-msb（历史行为不变）", () => {
    expect(loadServerConfig(without(BASE_ENV, "MODULE_ID")).moduleId).toBe("us-msb");
  });

  it("MODULE_ID=ae-msb 正常读出（第 5 法域，2026-08 上线）", () => {
    expect(loadServerConfig({ ...BASE_ENV, MODULE_ID: "ae-msb" }).moduleId).toBe("ae-msb");
  });

  it("MODULE_ID 不在白名单时启动就失败，并列出合法取值", () => {
    // 这个值会被拼进会花钱的 URL；不 fail-fast 就要等第一次付款才炸成 404。
    const env = { ...BASE_ENV, MODULE_ID: "xx-msb" };
    let caught: ServerConfigError | undefined;
    try {
      loadServerConfig(env);
    } catch (error: unknown) {
      caught = error as ServerConfigError;
    }

    expect(caught).toBeInstanceOf(ServerConfigError);
    expect(caught!.issues.map((issue) => issue.name)).toContain("MODULE_ID");
    expect(caught!.message).toContain("us-msb|uk-msb|eu-msb|sg-msb|ae-msb");
    // 不回显配错的值，与本文件其他读取器的纪律一致。
    expect(caught!.message).not.toContain("xx-msb");
  });

  it("MODULE_ID 非法与其他问题一起报出，不提前抛断", () => {
    const env = { ...without(BASE_ENV, "VERIFIER_ADDRESS"), MODULE_ID: "xx-msb" };
    let caught: ServerConfigError | undefined;
    try {
      loadServerConfig(env);
    } catch (error: unknown) {
      caught = error as ServerConfigError;
    }
    const names = caught!.issues.map((issue) => issue.name);
    expect(names).toContain("MODULE_ID");
    expect(names).toContain("VERIFIER_ADDRESS");
  });
});

describe("loadVerifierServiceConfig", () => {
  const VERIFIER_ENV: Record<string, string> = {
    INTERNAL_SERVICE_TOKEN: "token-value",
    JOB_CONTRACT_ADDRESS: ADDRESS_A,
    USDC_ADDRESS: ADDRESS_B,
  };

  it("读出验证器服务配置", () => {
    const config = loadVerifierServiceConfig(VERIFIER_ENV);
    expect(config.port).toBe(3001);
    expect(config.token).toBe("token-value");
  });

  it("缺令牌时拒绝启动", () => {
    const env = without(VERIFIER_ENV, "INTERNAL_SERVICE_TOKEN");
    expect(() => loadVerifierServiceConfig(env)).toThrow(/INTERNAL_SERVICE_TOKEN/);
  });

  it("缺多项时同样一次报全", () => {
    let caught: ServerConfigError | undefined;
    try {
      loadVerifierServiceConfig({});
    } catch (error: unknown) {
      caught = error as ServerConfigError;
    }
    const names = caught!.issues.map((issue) => issue.name);
    expect(names).toContain("INTERNAL_SERVICE_TOKEN");
    expect(names).toContain("JOB_CONTRACT_ADDRESS");
    expect(names).toContain("USDC_ADDRESS");
  });

  // 验证器私钥的唯一出口是 verifier 包的 readVerifierKey()，不在这里读。
  it("不读取任何链上私钥（含验证器自己那把）", () => {
    const { env, reads } = recordingEnv({ ...VERIFIER_ENV, VERIFIER_PRIVATE_KEY: VERIFIER_KEY });
    loadVerifierServiceConfig(env);
    for (const key of [
      "VERIFIER_PRIVATE_KEY",
      "OPERATOR_PRIVATE_KEY",
      "MARKETPLACE_PRIVATE_KEY",
      "PROCUREMENT_PRIVATE_KEY",
      "OPENAI_API_KEY",
    ]) {
      expect(reads).not.toContain(key);
    }
  });
});

describe("sellerPriceUsdc", () => {
  it("把最小单位换算成 USDC——直接填原子值会把报价放大一百万倍", () => {
    expect(
      sellerPriceUsdc({
        mode: "x402-arc-testnet",
        facilitatorUrl: "https://f.test",
        payTo: ADDRESS_A,
        priceAtomic: "3000000",
        publicBaseUrl: "https://a.test",
      }),
    ).toBe("3.000000");
  });

  it("保留 6 位小数，不丢精度", () => {
    expect(
      sellerPriceUsdc({
        mode: "x402-arc-testnet",
        facilitatorUrl: "https://f.test",
        payTo: ADDRESS_A,
        priceAtomic: "1",
        publicBaseUrl: "https://a.test",
      }),
    ).toBe("0.000001");
  });

  it("未收费时为 null，不编一个价格", () => {
    expect(sellerPriceUsdc({ mode: "off" })).toBeNull();
  });
});

describe("一次性报全部配置问题", () => {
  it("缺多项时一次列全，而不是撞一个报一个", () => {
    // 主导实测撞了 7 次才起来：每次只报一个，补一个重来一轮。
    const env = without(
      without(without(without(BASE_ENV, "CASE_BUDGET_USDC"), "RUBRIC_PATH"), "VERIFIER_ADDRESS"),
      "MSB_AGENT_BASE_URL",
    );
    let caught: ServerConfigError | undefined;
    try {
      loadServerConfig(env);
    } catch (error: unknown) {
      caught = error as ServerConfigError;
    }

    expect(caught).toBeInstanceOf(ServerConfigError);
    const names = caught!.issues.map((issue) => issue.name);
    expect(names).toContain("CASE_BUDGET_USDC");
    expect(names).toContain("RUBRIC_PATH");
    expect(names).toContain("VERIFIER_ADDRESS");
    expect(names).toContain("MSB_AGENT_BASE_URL");
    // 消息里逐条列出，人能一次看全、一次补完。
    expect(caught!.message).toContain("共 4 项问题");
    expect(caught!.message).toContain(".env.example");
  });

  it("付费模式缺三个卖方变量时一次报全", () => {
    const env = { ...BASE_ENV, X402_SELL_MODE: "x402-arc-testnet" };
    let caught: ServerConfigError | undefined;
    try {
      loadServerConfig(env);
    } catch (error: unknown) {
      caught = error as ServerConfigError;
    }
    const names = caught!.issues.map((issue) => issue.name);
    expect(names).toContain("X402_FACILITATOR_URL");
    expect(names).toContain("X402_SELL_PAY_TO");
    expect(names).toContain("PUBLIC_BASE_URL");
  });

  it("报错里不出现任何私钥值", () => {
    const env = { ...without(BASE_ENV, "OPERATOR_PRIVATE_KEY"), MARKETPLACE_PRIVATE_KEY: "0xzz" };
    try {
      loadServerConfig(env);
    } catch (error: unknown) {
      const message = (error as Error).message;
      expect(message).not.toContain(MARKETPLACE);
      expect(message).not.toContain(PROCUREMENT);
      expect(message).not.toContain("0xzz");
    }
  });
});

describe("路径按仓库根解析", () => {
  it("相对 RUBRIC_PATH 解析成绝对路径（不看 cwd）", () => {
    const config = loadServerConfig(BASE_ENV);
    expect(config.rubricPath.startsWith("/")).toBe(true);
    expect(config.rubricPath.endsWith("/rubrics/us-msb.json")).toBe(true);
  });

  it("以 ./ 开头同样能解析——这正是主导踩到 ENOENT 的写法", () => {
    const config = loadServerConfig({ ...BASE_ENV, RUBRIC_PATH: "./rubrics/us-msb.json" });
    expect(config.rubricPath.endsWith("/rubrics/us-msb.json")).toBe(true);
  });

  it("文件不存在时启动就报，并给出解析后的绝对路径", () => {
    let caught: ServerConfigError | undefined;
    try {
      loadServerConfig({ ...BASE_ENV, RUBRIC_PATH: "rubrics/nope.json" });
    } catch (error: unknown) {
      caught = error as ServerConfigError;
    }
    const issue = caught!.issues.find((i) => i.name === "RUBRIC_PATH");
    expect(issue?.reason).toContain("文件不存在");
    expect(issue?.reason).toContain("/rubrics/nope.json");
  });
});
