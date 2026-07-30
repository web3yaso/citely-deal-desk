import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SYNTHETIC_MODULE_RESPONSE } from "../fixtures/module-response.js";
import {
  loadPurchase,
  purchaseCachePath,
  PurchaseCacheError,
  savePurchase,
} from "./purchase-cache.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "citely-pc-")), "deal-desk.sqlite");
}

const PURCHASE = {
  response: SYNTHETIC_MODULE_RESPONSE,
  settlementId: "gw-settle-abc123",
  paidAtomic: "800000",
  purchasedAt: "2026-07-30T00:00:00.000Z",
} as const;

describe("采购幂等缓存（不变量 6：重试不重复付款）", () => {
  it("缓存路径挂在 DB 目录下，db:reset 能一并清掉", () => {
    const db = tmpDb();
    const path = purchaseCachePath(db, "citely-demo-0001", "us-msb");
    expect(path.startsWith(join(db, "..").replace(/\/\.\.$/, ""))).toBe(true);
    expect(path).toContain("purchases");
    expect(path.endsWith("citely-demo-0001__us-msb.json")).toBe(true);
  });

  it("没买过时返回 null（首次采购要真付费）", () => {
    expect(loadPurchase(purchaseCachePath(tmpDb(), "case-x", "us-msb"))).toBeNull();
  });

  it("买过之后读回来，回执与实付金额完整保留", () => {
    const path = purchaseCachePath(tmpDb(), "case-x", "us-msb");
    savePurchase(path, PURCHASE);
    const loaded = loadPurchase(path);
    expect(loaded?.settlementId).toBe("gw-settle-abc123");
    expect(loaded?.paidAtomic).toBe("800000");
    // 回执是账本 module_fee/royalty 行的 ref，丢了这两行就渲染不出来。
    expect(loaded?.response.module).toBe("us-msb");
  });

  it("不同案件各自独立计费（不会串用别案的采购）", () => {
    const db = tmpDb();
    const a = purchaseCachePath(db, "case-a", "us-msb");
    const b = purchaseCachePath(db, "case-b", "us-msb");
    savePurchase(a, PURCHASE);
    expect(loadPurchase(a)).not.toBeNull();
    expect(loadPurchase(b)).toBeNull();
  });

  it("不同 Module 各自独立计费", () => {
    const db = tmpDb();
    savePurchase(purchaseCachePath(db, "case-a", "us-msb"), PURCHASE);
    expect(loadPurchase(purchaseCachePath(db, "case-a", "sg-msb"))).toBeNull();
  });

  // 损坏的缓存若被当成"没买过"，就会重复付款——正是本模块要防的事。
  it("缓存损坏 → 抛错，绝不静默当作没买过", () => {
    const path = purchaseCachePath(tmpDb(), "case-x", "us-msb");
    savePurchase(path, PURCHASE);
    writeFileSync(path, "{ not json", "utf8");
    expect(() => loadPurchase(path)).toThrow(PurchaseCacheError);
  });

  it("缺回执的缓存 → 抛错（没有 ref 就记不了账）", () => {
    const path = purchaseCachePath(tmpDb(), "case-x", "us-msb");
    savePurchase(path, PURCHASE);
    writeFileSync(path, JSON.stringify({ ...PURCHASE, settlementId: "" }), "utf8");
    expect(() => loadPurchase(path)).toThrow(PurchaseCacheError);
  });

  it("响应形状被改坏 → 抛错", () => {
    const path = purchaseCachePath(tmpDb(), "case-x", "us-msb");
    savePurchase(path, PURCHASE); // 先落一份合法的，把目录建出来
    writeFileSync(path, JSON.stringify({ ...PURCHASE, response: { module: "us-msb" } }), "utf8");
    expect(() => loadPurchase(path)).toThrow();
  });
});
