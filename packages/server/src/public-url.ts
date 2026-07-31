/**
 * 解析服务公网基地址。
 *
 * 这个值会被写进 ERC-8004 的 agent card（注册用的 URI 指向它），所以**绝不能猜**：
 * 猜错就等于把一个错误地址登记上链。付费模式下还必须是 HTTPS——x402 的付款凭证
 * 走明文 HTTP 会被中间人拿走。
 */

/** 环境变量来源。注入是为了让测试不去动 `process.env`。 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** 公网地址配置错误。message 只描述变量名与形状，不回显可能带凭证的原值。 */
export class PublicUrlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

export interface ResolvePublicBaseUrlOptions {
  /** 是否开启 x402 收费。开启时强制 HTTPS 且不允许回落到 localhost。 */
  readonly paymentEnabled: boolean;
  /** 监听端口，仅在未收费且未配置公网地址时用于拼本地地址。 */
  readonly port: number;
}

/**
 * 解析并规范化公网基地址。
 *
 * @param source - 环境变量来源
 * @param options - 是否收费与监听端口
 * @returns 规范化后的基地址（无尾斜杠、无 query、无 fragment）
 * @throws {PublicUrlError} 收费模式下缺失/非 HTTPS，或地址非法
 */
export function resolvePublicBaseUrl(
  source: EnvSource,
  options: ResolvePublicBaseUrlOptions,
): string {
  const raw = source["PUBLIC_BASE_URL"]?.trim();
  if (raw === undefined || raw === "") {
    // 不收费时（本地开发）允许拼 localhost；收费时缺地址必须炸。
    if (!options.paymentEnabled) return `http://localhost:${String(options.port)}`;
    throw new PublicUrlError("公网地址配置缺失：PUBLIC_BASE_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PublicUrlError("非法公网地址：PUBLIC_BASE_URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PublicUrlError("PUBLIC_BASE_URL 必须使用 HTTP(S)");
  }
  if (options.paymentEnabled && parsed.protocol !== "https:") {
    throw new PublicUrlError("PUBLIC_BASE_URL 在付费模式下必须使用 HTTPS");
  }

  // query / fragment 可能带凭证，且对基地址无意义——一律剥掉再上链。
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}
