import { describe, expect, it } from "vitest";

import { PublicUrlError, resolvePublicBaseUrl } from "./public-url.js";

const FREE = { paymentEnabled: false, port: 3000 } as const;
const PAID = { paymentEnabled: true, port: 3000 } as const;

describe("resolvePublicBaseUrl", () => {
  it("未收费且未配置时回落到 localhost", () => {
    expect(resolvePublicBaseUrl({}, FREE)).toBe("http://localhost:3000");
  });

  it("收费但未配置时报错，绝不猜地址", () => {
    expect(() => resolvePublicBaseUrl({}, PAID)).toThrow(PublicUrlError);
  });

  it("收费模式拒绝 HTTP", () => {
    expect(() => resolvePublicBaseUrl({ PUBLIC_BASE_URL: "http://a.test" }, PAID)).toThrow(
      /HTTPS/,
    );
  });

  it("收费模式接受 HTTPS 并去掉尾斜杠", () => {
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: "https://a.test/" }, PAID)).toBe(
      "https://a.test",
    );
  });

  it("剥掉 query 与 fragment（可能带凭证）", () => {
    expect(
      resolvePublicBaseUrl({ PUBLIC_BASE_URL: "https://a.test/base?token=x#y" }, PAID),
    ).toBe("https://a.test/base");
  });

  it("拒绝非 HTTP(S) 协议", () => {
    expect(() => resolvePublicBaseUrl({ PUBLIC_BASE_URL: "ftp://a.test" }, FREE)).toThrow(
      /HTTP\(S\)/,
    );
  });

  it("拒绝非法 URL", () => {
    expect(() => resolvePublicBaseUrl({ PUBLIC_BASE_URL: "not a url" }, FREE)).toThrow(
      /非法公网地址/,
    );
  });

  it("空白串等同未配置", () => {
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: "   " }, FREE)).toBe("http://localhost:3000");
  });
});
