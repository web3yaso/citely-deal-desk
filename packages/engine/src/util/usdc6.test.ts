import { describe, expect, it } from "vitest";

import {
  addUsdc6,
  formatUsdc6,
  subUsdc6,
  usdc6,
  usdc6FromAtomicString,
  usdc6FromDecimal,
  usdc6ToAtomicString,
  USDC6_ZERO,
  USDC_ONE,
  Usdc6Error,
} from "./usdc6.js";
import type { Usdc6 } from "./usdc6.js";

describe("usdc6", () => {
  it("标记最小单位整数", () => {
    expect(usdc6(100_000_000n)).toBe(100_000_000n);
    expect(USDC6_ZERO).toBe(0n);
    expect(USDC_ONE).toBe(1_000_000n);
  });

  it("拒绝负数（方向由 direction 表达，不用负金额）", () => {
    expect(() => usdc6(-1n)).toThrow(Usdc6Error);
  });
});

describe("usdc6FromDecimal", () => {
  it.each([
    ["100.00", 100_000_000n],
    ["100", 100_000_000n],
    ["0.80", 800_000n],
    ["0.000001", 1n],
    ["0", 0n],
    ["12500.5", 12_500_500_000n],
  ])("%s → %s", (decimal, expected) => {
    expect(usdc6FromDecimal(decimal)).toBe(expected);
  });

  it("v2.3 §9 的例子：100.00 → 100000000", () => {
    expect(usdc6FromDecimal("100.00")).toBe(100_000_000n);
  });

  it.each(["", "-1", "1.2345678", "1e6", "abc", "1,000", " 1.0.0 "])(
    "拒绝非法形状 %o",
    (raw) => {
      expect(() => usdc6FromDecimal(raw)).toThrow(Usdc6Error);
    },
  );

  it("超过 6 位小数直接报错，不静默截断", () => {
    expect(() => usdc6FromDecimal("0.1234567")).toThrow(Usdc6Error);
  });
});

describe("原子字符串往返", () => {
  it("往返无损", () => {
    const value = usdc6FromDecimal("9650.123456");
    expect(usdc6FromAtomicString(usdc6ToAtomicString(value))).toBe(value);
  });

  it.each(["", "-1", "1.0", "0x10"])("拒绝非法原子字符串 %o", (raw) => {
    expect(() => usdc6FromAtomicString(raw)).toThrow(Usdc6Error);
  });
});

describe("formatUsdc6（渲染层唯一转换点）", () => {
  it.each([
    [100_000_000n, 2, "100.00"],
    [9_650_000n, 2, "9.65"],
    [1n, 6, "0.000001"],
    [1n, 2, "0.00"],
    [12_500_500_000n, 2, "12500.50"],
    [100_000_000n, 0, "100"],
  ])("%s (decimals=%s) → %s", (atomic, decimals, expected) => {
    expect(formatUsdc6(usdc6(atomic), decimals)).toBe(expected);
  });

  it("截断不四舍五入（金额显示不许把 0.009 显示成 0.01）", () => {
    expect(formatUsdc6(usdc6(9_000n), 2)).toBe("0.00");
  });

  it("小数位越界报错", () => {
    expect(() => formatUsdc6(USDC6_ZERO, 7)).toThrow(Usdc6Error);
    expect(() => formatUsdc6(USDC6_ZERO, -1)).toThrow(Usdc6Error);
  });
});

describe("加减", () => {
  it("加法结果仍是 Usdc6", () => {
    expect(addUsdc6(usdc6(1n), usdc6(2n))).toBe(3n);
  });

  it("减到负数报错而不是静默记负", () => {
    expect(subUsdc6(usdc6(3n), usdc6(1n))).toBe(2n);
    expect(() => subUsdc6(usdc6(1n), usdc6(3n))).toThrow(Usdc6Error);
  });
});

describe("类型约束是真的（不是注释）", () => {
  it("裸 bigint 不能直接当 Usdc6——只能经 usdc6() 这道门", () => {
    // @ts-expect-error 裸 bigint 缺 brand：这行编译不过，正是 T4 要的"类型约束"。
    //   若哪天 Usdc6 被改回裸别名，这里的 ts-expect-error 会因"没有错误"而报错，
    //   等于给这条纪律加了一个编译期的看门狗。
    const wrong: Usdc6 = 100n;
    expect(typeof wrong).toBe("bigint");
  });

  it("反方向安全：Usdc6 可直接当 bigint 用（跨包边界零摩擦）", () => {
    const asBigint: bigint = usdc6(5n);
    expect(asBigint * 2n).toBe(10n);
  });
});
