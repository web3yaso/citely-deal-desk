import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";

import { ChainError } from "./errors.js";
import { PaidRetryStore, paymentCredentialId } from "./paid-retry.js";
import {
  ARC_GATEWAY_BATCHED_EXTRA,
  createPaidRoute,
  createSellPrice,
  DEFAULT_SELL_PRICE_USDC,
  loadSellerPaymentConfig,
  readPaymentCredential,
  readPaymentCredentialId,
  type ActiveSellerPaymentConfig,
  type PaidRouteSpec,
  type SellerMiddlewareFactory,
} from "./x402-server.js";
import { ARC_TESTNET_USDC } from "./x402-client.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";

const ENV = {
  X402_FACILITATOR_URL: "https://gateway-api-testnet.circle.com/v1/x402",
  X402_SELL_PAY_TO: PAY_TO,
  X402_SELL_PRICE_USDC: "2.5",
  PUBLIC_BASE_URL: "https://deal-desk.example.com",
} as const;

const CONFIG: ActiveSellerPaymentConfig = {
  mode: "x402-arc-testnet",
  facilitatorUrl: ENV.X402_FACILITATOR_URL,
  payTo: PAY_TO,
  priceAtomic: "2500000",
  publicBaseUrl: ENV.PUBLIC_BASE_URL,
};

describe("loadSellerPaymentConfig", () => {
  it("默认开启 arc-testnet 收费并读全配置", () => {
    expect(loadSellerPaymentConfig(ENV)).toEqual(CONFIG);
  });

  it("mode=off 时只返回开关，不要求任何定价配置", () => {
    expect(loadSellerPaymentConfig({ X402_SELL_MODE: "off" })).toEqual({ mode: "off" });
  });

  it("未配置单价时回落到默认价", () => {
    const config = loadSellerPaymentConfig({ ...ENV, X402_SELL_PRICE_USDC: "" });
    expect(config).toMatchObject({ priceAtomic: "1000000" });
    expect(DEFAULT_SELL_PRICE_USDC).toBe("1.00");
  });

  it("非法 mode 报错", () => {
    expect(() => loadSellerPaymentConfig({ ...ENV, X402_SELL_MODE: "free" })).toThrow(ChainError);
  });

  it("缺收款地址报错，且指名道姓", () => {
    expect(() => loadSellerPaymentConfig({ ...ENV, X402_SELL_PAY_TO: "" })).toThrow(
      /X402_SELL_PAY_TO/,
    );
  });

  it("缺公网基址报错（报价单 resource 拼不出来）", () => {
    expect(() => loadSellerPaymentConfig({ ...ENV, PUBLIC_BASE_URL: "" })).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  it("单价超过 100 USDC 上限报错", () => {
    expect(() => loadSellerPaymentConfig({ ...ENV, X402_SELL_PRICE_USDC: "100.000001" })).toThrow(
      ChainError,
    );
  });

  it("单价格式非法报错", () => {
    expect(() => loadSellerPaymentConfig({ ...ENV, X402_SELL_PRICE_USDC: "0" })).toThrow(
      ChainError,
    );
  });
});

describe("createSellPrice", () => {
  it("用 AssetAmount + GatewayWalletBatched 域，而不是 $ 金额", () => {
    expect(createSellPrice(CONFIG)).toEqual({
      amount: "2500000",
      asset: ARC_TESTNET_USDC,
      extra: { ...ARC_GATEWAY_BATCHED_EXTRA },
    });
  });

  it("EIP-712 验签合约是 Gateway Wallet 且为小写字面量", () => {
    expect(ARC_GATEWAY_BATCHED_EXTRA.verifyingContract).toBe(
      "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    );
  });
});

describe("readPaymentCredential", () => {
  it("认 payment-signature 头", () => {
    const request = new Request("https://x.test/", { headers: { "payment-signature": "sig" } });
    expect(readPaymentCredential(request)).toBe("sig");
  });

  it("认 x-payment 头", () => {
    const request = new Request("https://x.test/", { headers: { "x-payment": "pay" } });
    expect(readPaymentCredential(request)).toBe("pay");
  });

  it("没有凭证时返回 undefined", () => {
    expect(readPaymentCredential(new Request("https://x.test/"))).toBeUndefined();
  });
});

describe("readPaymentCredentialId", () => {
  it("回显的是哈希，不是凭证原文", () => {
    const request = new Request("https://x.test/", { headers: { "x-payment": "secret-cred" } });
    const id = readPaymentCredentialId(request);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(paymentCredentialId("secret-cred"));
  });

  it("没有凭证时返回 undefined", () => {
    expect(readPaymentCredentialId(new Request("https://x.test/"))).toBeUndefined();
  });
});

/** 假 x402 中间件：有凭证就放行，没有就 402。记录被调用次数与收到的 spec。 */
function fakeFactory(): {
  factory: SellerMiddlewareFactory;
  specs: PaidRouteSpec[];
  calls: () => number;
} {
  const specs: PaidRouteSpec[] = [];
  let calls = 0;
  const factory: SellerMiddlewareFactory = (spec) => {
    specs.push(spec);
    const middleware: MiddlewareHandler = async (context, next) => {
      calls += 1;
      if (readPaymentCredential(context.req.raw) === undefined) {
        return context.json({ error: "payment_required" }, 402);
      }
      await next();
      return undefined;
    };
    return middleware;
  };
  return { factory, specs, calls: () => calls };
}

interface AppOptions {
  readonly factory: SellerMiddlewareFactory;
  readonly retryStore?: PaidRetryStore;
  readonly handler?: MiddlewareHandler;
  readonly onError?: (error: ChainError) => void;
}

function buildApp(options: AppOptions): { app: Hono; handled: () => number } {
  let handled = 0;
  const app = new Hono();
  const route = createPaidRoute({
    config: CONFIG,
    path: "/deals/review",
    description: "Deal Desk 判定",
    factory: options.factory,
    ...(options.retryStore === undefined ? {} : { retryStore: options.retryStore }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  app.use("/deals/review", route);
  app.post("/deals/review", async (context) => {
    handled += 1;
    if (options.handler !== undefined) {
      const response = await options.handler(context, async () => undefined);
      if (response instanceof Response) {
        return response;
      }
    }
    return context.json({ verdict: "GREEN" });
  });
  return { app, handled: () => handled };
}

const REVIEW_URL = "https://deal-desk.example.com/deals/review";
const BODY = JSON.stringify({ deal_id: "D-1" });

function paidRequest(credential = "cred-1", body = BODY): Request {
  return new Request(REVIEW_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": credential },
    body,
  });
}

describe("createPaidRoute", () => {
  it("报价单 resource 由公网基址 + 路径拼成", () => {
    const fake = fakeFactory();
    buildApp({ factory: fake.factory });
    expect(fake.specs[0]?.resource).toBe(REVIEW_URL);
  });

  it("无支付凭证时回 402，业务 handler 不执行", async () => {
    const fake = fakeFactory();
    const { app, handled } = buildApp({ factory: fake.factory });
    const response = await app.request(
      new Request(REVIEW_URL, { method: "POST", body: BODY }),
    );
    expect(response.status).toBe(402);
    expect(handled()).toBe(0);
  });

  it("带凭证付款通过后执行业务", async () => {
    const fake = fakeFactory();
    const { app, handled } = buildApp({ factory: fake.factory });
    const response = await app.request(paidRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verdict: "GREEN" });
    expect(handled()).toBe(1);
  });

  it("已收款但业务 5xx：同凭证同请求体重试不再走验款", async () => {
    const fake = fakeFactory();
    const retryStore = new PaidRetryStore();
    const failing: MiddlewareHandler = async (context) => context.json({ error: "boom" }, 503);
    const { app, handled } = buildApp({ factory: fake.factory, retryStore, handler: failing });

    const first = await app.request(paidRequest());
    expect(first.status).toBe(503);
    expect(fake.calls()).toBe(1);
    expect(retryStore.size).toBe(1);

    const second = await app.request(paidRequest());
    expect(second.status).toBe(503);
    // 验款中间件没有被第二次调用 —— 也就没有第二次计费。
    expect(fake.calls()).toBe(1);
    expect(handled()).toBe(2);
  });

  it("换了请求体就不是同一笔，必须重新付款", async () => {
    const fake = fakeFactory();
    const retryStore = new PaidRetryStore();
    const failing: MiddlewareHandler = async (context) => context.json({ error: "boom" }, 500);
    const { app } = buildApp({ factory: fake.factory, retryStore, handler: failing });

    await app.request(paidRequest());
    await app.request(paidRequest("cred-1", JSON.stringify({ deal_id: "D-2" })));
    expect(fake.calls()).toBe(2);
  });

  it("业务成功时不记忆重试键（凭证已被结算，不该再免单）", async () => {
    const fake = fakeFactory();
    const retryStore = new PaidRetryStore();
    const { app } = buildApp({ factory: fake.factory, retryStore });
    await app.request(paidRequest());
    expect(retryStore.size).toBe(0);
  });

  it("facilitator 抛错且未收款时回 502，并把原错误上报给宿主", async () => {
    const errors: ChainError[] = [];
    const factory: SellerMiddlewareFactory = () => () => {
      throw new Error("facilitator 503");
    };
    const { app, handled } = buildApp({ factory, onError: (error) => errors.push(error) });

    const response = await app.request(paidRequest());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: "facilitator_unavailable" });
    expect(handled()).toBe(0);
    expect(errors[0]).toBeInstanceOf(ChainError);
    expect(errors[0]?.message).toContain("facilitator 503");
  });

  it("收款后业务抛错：记忆重试键并把错误包成 ChainError 抛出", async () => {
    const fake = fakeFactory();
    const retryStore = new PaidRetryStore();
    const throwing: MiddlewareHandler = () => {
      throw new Error("判定器崩了");
    };
    const { app } = buildApp({ factory: fake.factory, retryStore, handler: throwing });

    const response = await app.request(paidRequest());
    expect(response.status).toBe(500);
    expect(retryStore.size).toBe(1);
  });
});
