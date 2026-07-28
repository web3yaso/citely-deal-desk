import { describe, expect, it } from "vitest";

import { CanonicalJsonError, canonicalBytes, canonicalJson } from "./canonical.js";
import { sha256Canonical, sha256Hex, sha256Hex0x } from "./hash.js";

describe("canonicalJson", () => {
  it("按键排序且与书写顺序无关", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it("不产出任何空白字符", () => {
    const out = canonicalJson({ z: [1, 2, { y: "x" }], a: null });
    expect(out).toBe('{"a":null,"z":[1,2,{"y":"x"}]}');
    expect(/\s/.test(out)).toBe(false);
  });

  it("保持数组顺序（数组顺序是语义）", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("深层嵌套稳定", () => {
    const deep = { a: { c: { e: [{ g: 1, f: 2 }] }, b: 1 } };
    expect(canonicalJson(deep)).toBe('{"a":{"b":1,"c":{"e":[{"f":2,"g":1}]}}}');
  });

  it("Unicode 与转义稳定", () => {
    expect(canonicalJson({ k: "中文 🇺🇸" })).toBe('{"k":"中文 🇺🇸"}');
    // 零宽字符不是 JSON 控制字符，原样保留（沙箱负责检测它，规范化层不做清洗）
    expect(canonicalJson("a​b")).toBe('"a​b"');
    expect(canonicalJson("行\n分")).toBe('"行\\n分"');
    expect(canonicalJson("引\"号\\反斜杠")).toBe('"引\\"号\\\\反斜杠"');
    // 孤立代理对必须被转义（well-formed JSON.stringify）
    expect(canonicalJson("\ud800")).toBe('"\\ud800"');
  });

  it("键排序按 UTF-16 码元，非本地化排序", () => {
    expect(canonicalJson({ Z: 1, a: 2, A: 3 })).toBe('{"A":3,"Z":1,"a":2}');
  });

  it("基本类型直出", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson("")).toBe('""');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("拒绝 undefined（顶层与嵌套，均不静默丢字段）", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
  });

  it("拒绝 NaN / Infinity", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Number.NEGATIVE_INFINITY })).toThrow(/non-finite/);
  });

  it("拒绝 bigint / 函数 / symbol", () => {
    expect(() => canonicalJson({ amount: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ s: Symbol("s") })).toThrow(/symbol/);
  });

  it("拒绝非纯对象（Date/Map/class 实例）", () => {
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/non-plain object/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/non-plain object/);
    expect(() => canonicalJson({ r: /x/ })).toThrow(/non-plain object/);
  });

  it("接受 Object.create(null) 原型的纯对象", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare["b"] = 1;
    bare["a"] = 2;
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });

  it("拒绝循环引用", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
  });

  it("同一对象出现两次（非循环）不算循环引用", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("错误信息含路径且不含值本身", () => {
    try {
      canonicalJson({ outer: { inner: [1, Number.NaN] } });
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalJsonError);
      expect((err as CanonicalJsonError).path).toBe("outer.inner.[1]");
    }
  });
});

describe("canonicalBytes / hash", () => {
  it("canonicalBytes 是 canonicalJson 的 UTF-8 字节", () => {
    const value = { k: "中" };
    expect(canonicalBytes(value)).toEqual(new TextEncoder().encode(canonicalJson(value)));
  });

  it("sha256Hex 对已知向量正确", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex0x("abc")).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("sha256Canonical 与键序无关", () => {
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
  });
});
