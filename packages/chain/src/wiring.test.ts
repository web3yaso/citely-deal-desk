import { describe, expect, it } from "vitest";

import { ENV_KEYS } from "./config/env.js";
import { createJobRoleClients, toJobRoleWallets } from "./wiring.js";

// 假私钥，格式合法但不对应任何真实账户；建 client 不联网。
const ENV = {
  [ENV_KEYS.marketplaceKey]: `0x${"a".repeat(64)}`,
  [ENV_KEYS.operatorKey]: `0x${"b".repeat(64)}`,
  [ENV_KEYS.verifierKey]: `0x${"c".repeat(64)}`,
};
const RPC = { primaryUrl: "https://primary.invalid", fallbackUrl: "https://fallback.invalid" };

describe("createJobRoleClients", () => {
  it("三个角色各用各的密钥，地址互不相同", () => {
    const clients = createJobRoleClients(ENV, RPC);
    const addresses = [clients.client.address, clients.provider.address, clients.evaluator.address];
    expect(new Set(addresses).size).toBe(3);
    expect(clients.client.role).toBe("marketplace");
    expect(clients.provider.role).toBe("operator");
    expect(clients.evaluator.role).toBe("verifier");
  });

  it("缺哪把密钥就报哪把", () => {
    const withoutVerifier: Record<string, string | undefined> = { ...ENV };
    delete withoutVerifier[ENV_KEYS.verifierKey];
    expect(() => createJobRoleClients(withoutVerifier, RPC)).toThrow(/VERIFIER_PRIVATE_KEY 缺失/);
  });

  it("toJobRoleWallets 取出的三个 walletClient 与角色一一对应", () => {
    const clients = createJobRoleClients(ENV, RPC);
    const wallets = toJobRoleWallets(clients);
    expect(wallets.client.account.address).toBe(clients.client.address);
    expect(wallets.provider.account.address).toBe(clients.provider.address);
    expect(wallets.evaluator.account.address).toBe(clients.evaluator.address);
  });
});
