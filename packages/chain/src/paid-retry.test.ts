import { describe, expect, it } from "vitest";

import {
  PAID_RETRY_WINDOW_MS,
  PaidRetryStore,
  paymentCredentialId,
  paymentRetryKey,
} from "./paid-retry.js";

const CREDENTIAL = "eyJ4NDAyVmVyc2lvbiI6MX0=";

describe("paymentCredentialId", () => {
  it("同一凭证得到同一哈希，且不含凭证原文", () => {
    const id = paymentCredentialId(CREDENTIAL);
    expect(id).toBe(paymentCredentialId(CREDENTIAL));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(CREDENTIAL);
  });

  it("不同凭证得到不同哈希", () => {
    expect(paymentCredentialId(CREDENTIAL)).not.toBe(paymentCredentialId(`${CREDENTIAL}x`));
  });
});

describe("paymentRetryKey", () => {
  const id = paymentCredentialId(CREDENTIAL);

  it("凭证、路径、请求体三者相同才是同一个键", () => {
    expect(paymentRetryKey(id, "/review", "{}")).toBe(paymentRetryKey(id, "/review", "{}"));
  });

  it("换路径即换键（防止已付凭证换资源白嫖）", () => {
    expect(paymentRetryKey(id, "/review", "{}")).not.toBe(paymentRetryKey(id, "/other", "{}"));
  });

  it("换请求体即换键", () => {
    expect(paymentRetryKey(id, "/review", "{}")).not.toBe(
      paymentRetryKey(id, "/review", '{"a":1}'),
    );
  });

  it("分段边界不会串味（拼接歧义）", () => {
    expect(paymentRetryKey(id, "/a", "b")).not.toBe(paymentRetryKey(id, "/ab", ""));
  });
});

describe("PaidRetryStore", () => {
  it("未记住的键返回 false", () => {
    expect(new PaidRetryStore().has("k")).toBe(false);
  });

  it("记住后在窗口内返回 true", () => {
    let now = 1_000;
    const store = new PaidRetryStore(() => now);
    store.remember("k");
    now += PAID_RETRY_WINDOW_MS - 1;
    expect(store.has("k")).toBe(true);
  });

  it("超过窗口即失效并清理", () => {
    let now = 1_000;
    const store = new PaidRetryStore(() => now);
    store.remember("k");
    now += PAID_RETRY_WINDOW_MS;
    expect(store.has("k")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("重复记住同一键只占一条", () => {
    const store = new PaidRetryStore();
    store.remember("k");
    store.remember("k");
    expect(store.size).toBe(1);
  });
});
