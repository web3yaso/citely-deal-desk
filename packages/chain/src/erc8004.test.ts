import {
  encodeEventTopics,
  getAddress,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { describe, expect, it } from "vitest";

import { identityRegistryAbi } from "./abi/identity-registry.js";
import { ChainError } from "./errors.js";
import type { ChainClients } from "./wallet.js";
import {
  arcscanTxUrl,
  assertAgentCard,
  buildVerificationChecks,
  encodeRegistryCall,
  DEFAULT_IDENTITY_REGISTRY,
  extractAgentId,
  formatVerificationLine,
  lookupRegistration,
  parseAgentId,
  probeAgentCard,
  probeIdentityRegistry,
  registerCall,
  REGISTRATION_TYPE,
  summarizeAgentCard,
  resolveAgentUri,
  resolveExpectedOwner,
  resolveRegistryAddress,
  sendRegistryCall,
  setAgentUriCall,
  type MintLog,
} from "./erc8004.js";

const REGISTRY = DEFAULT_IDENTITY_REGISTRY;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const URI = "https://deal-desk.example.com/.well-known/agent-card.json";

describe("resolveRegistryAddress", () => {
  it("都没给时用合约 §8 记录的默认注册表", () => {
    expect(resolveRegistryAddress([], undefined)).toBe(REGISTRY);
  });

  it("--registry 优先于环境变量，并转成校验和形式", () => {
    const lower = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
    expect(resolveRegistryAddress(["--registry", lower], OWNER)).toBe(REGISTRY);
  });

  it("环境变量次之", () => {
    expect(resolveRegistryAddress([], OWNER)).toBe(OWNER);
  });

  it("非法地址报错", () => {
    expect(() => resolveRegistryAddress(["--registry", "0xzz"], undefined)).toThrow(ChainError);
  });
});

describe("resolveAgentUri", () => {
  it("--uri 优先于 AGENT_CARD_URL", () => {
    expect(resolveAgentUri(["--uri", URI], "https://other.example.com/card.json")).toBe(URI);
  });

  it("缺失时报错并说清要等服务部署出 URL", () => {
    expect(() => resolveAgentUri([], undefined)).toThrow(/AGENT_CARD_URL/);
  });

  it("非 HTTPS 报错（链上写死不易改）", () => {
    expect(() => resolveAgentUri(["--uri", "http://localhost:3000/card.json"], undefined)).toThrow(
      ChainError,
    );
  });

  it("非法 URL 报错", () => {
    expect(() => resolveAgentUri([], "not a url")).toThrow(ChainError);
  });
});

const VALID_CARD = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Citely Deal Desk",
  disclaimer: "本输出不构成法律意见",
};

function jsonResponse(status: number, contentType = "application/json", body: unknown = VALID_CARD): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

describe("probeAgentCard", () => {
  it("200 + JSON 通过", async () => {
    await expect(probeAgentCard(URI, async () => jsonResponse(200))).resolves.toMatchObject({
      uri: URI,
      status: 200,
      contentType: "application/json",
      name: "Citely Deal Desk",
    });
  });

  it("探测结果带回可供人核对的摘要", async () => {
    const probe = await probeAgentCard(URI, async () => jsonResponse(200));
    expect(probe.summary.join("\n")).toContain("Citely Deal Desk");
    expect(probe.summary.some((line) => line.includes("字节"))).toBe(true);
  });

  it("404 报错", async () => {
    await expect(probeAgentCard(URI, async () => jsonResponse(404))).rejects.toThrow(/404/);
  });

  it("非 JSON content-type 报错", async () => {
    await expect(probeAgentCard(URI, async () => jsonResponse(200, "text/html"))).rejects.toThrow(
      ChainError,
    );
  });

  it("能打开但内容不是 agent card 时拒绝（注册死链的第二种形态）", async () => {
    await expect(
      probeAgentCard(URI, async () => jsonResponse(200, "application/json", { hello: "world" })),
    ).rejects.toThrow(ChainError);
  });

  it("content-type 说是 JSON 但正文不是 JSON 时报错", async () => {
    const broken = new Response("<html>", { status: 200, headers: { "content-type": "application/json" } });
    await expect(probeAgentCard(URI, async () => broken)).rejects.toThrow(/JSON 解析失败/);
  });

  it("连不上时包成 ChainError 而不是原样抛网络错", async () => {
    await expect(
      probeAgentCard(URI, () => Promise.reject(new Error("ENOTFOUND"))),
    ).rejects.toThrow(/ENOTFOUND/);
  });
});

interface StubOptions {
  readonly chainId?: number;
  readonly code?: `0x${string}` | undefined;
  readonly supportsErc721?: boolean;
  readonly balance?: bigint;
  readonly owner?: Address;
  readonly tokenUri?: string;
  /** `ownerOf` 抛错，模拟 tokenId 不存在。 */
  readonly ownerOfReverts?: boolean;
}

function makeClient(options: StubOptions = {}): PublicClient<Transport, Chain> {
  const stub = {
    getChainId: async () => options.chainId ?? 5042002,
    getCode: async () => options.code ?? "0x6080",
    readContract: async (req: { functionName: string }): Promise<unknown> => {
      switch (req.functionName) {
        case "supportsInterface":
          return options.supportsErc721 ?? true;
        case "name":
          return "ERC-8004 Identity";
        case "symbol":
          return "AGENT";
        case "balanceOf":
          return options.balance ?? 0n;
        case "ownerOf":
          if (options.ownerOfReverts === true) {
            throw new Error("execution reverted: ERC721NonexistentToken");
          }
          return options.owner ?? OWNER;
        case "tokenURI":
          return options.tokenUri ?? URI;
        default:
          throw new Error(`未预期的读调用：${req.functionName}`);
      }
    },
  };
  return stub as unknown as PublicClient<Transport, Chain>;
}

describe("probeIdentityRegistry", () => {
  it("链、字节码、ERC-721 三项都过时返回注册表信息", async () => {
    await expect(probeIdentityRegistry(makeClient(), REGISTRY)).resolves.toEqual({
      address: REGISTRY,
      chainId: 5042002,
      codeSize: 2,
      name: "ERC-8004 Identity",
      symbol: "AGENT",
    });
  });

  it("链不对直接报错", async () => {
    await expect(probeIdentityRegistry(makeClient({ chainId: 1 }), REGISTRY)).rejects.toThrow(
      /Arc Testnet/,
    );
  });

  it("地址上没合约报错", async () => {
    await expect(probeIdentityRegistry(makeClient({ code: "0x" }), REGISTRY)).rejects.toThrow(
      /没有合约/,
    );
  });

  it("不支持 ERC-721 报错", async () => {
    await expect(
      probeIdentityRegistry(makeClient({ supportsErc721: false }), REGISTRY),
    ).rejects.toThrow(/ERC-721/);
  });
});

function transferLog(from: Address, tokenId: bigint, address: Address = REGISTRY): MintLog {
  const topics = encodeEventTopics({
    abi: identityRegistryAbi,
    eventName: "Transfer",
    args: { from, to: OWNER, tokenId },
  });
  // 三个入参都非空，编码结果必然是 [事件签名, ...三个 indexed]；
  // encodeEventTopics 的返回类型为通配 args 保留了 null，这里按实际形状收窄。
  return { address, data: "0x", topics: topics as [`0x${string}`, ...`0x${string}`[]] };
}

describe("extractAgentId", () => {
  it("从铸造 Transfer 日志里取出 tokenId", () => {
    expect(extractAgentId([transferLog(ZERO, 851_930n)], REGISTRY)).toBe(851_930n);
  });

  it("忽略别的合约发的同名事件", () => {
    const foreign = transferLog(ZERO, 1n, OWNER);
    expect(extractAgentId([foreign, transferLog(ZERO, 42n)], REGISTRY)).toBe(42n);
  });

  it("忽略非铸造的转移（from 不是零地址）", () => {
    expect(() => extractAgentId([transferLog(OWNER, 7n)], REGISTRY)).toThrow(ChainError);
  });

  it("解不出来的日志跳过而不是崩", () => {
    const junk: MintLog = { address: REGISTRY, data: "0x", topics: [] };
    expect(extractAgentId([junk, transferLog(ZERO, 9n)], REGISTRY)).toBe(9n);
  });

  it("没有铸造日志时报错", () => {
    expect(() => extractAgentId([], REGISTRY)).toThrow(/Agent ID/);
  });
});

describe("buildVerificationChecks", () => {
  const base = { owner: OWNER, expectedOwner: OWNER, tokenUri: URI, expectedUri: URI };

  it("全对时三项皆 PASS", () => {
    expect(buildVerificationChecks(base).every((check) => check.passed)).toBe(true);
  });

  it("owner 大小写不同仍算一致", () => {
    const checks = buildVerificationChecks({ ...base, owner: OWNER.toUpperCase() as Address });
    expect(checks[0]?.passed).toBe(true);
  });

  it("URI 差一个字符即 FAIL", () => {
    const checks = buildVerificationChecks({ ...base, tokenUri: `${URI}?v=2` });
    expect(checks[1]?.passed).toBe(false);
    expect(checks[1]?.detail).toContain(`${URI}?v=2`);
  });

  it("链上 URI 非 HTTPS 即 FAIL", () => {
    const httpUri = "http://x.example.com/card.json";
    const checks = buildVerificationChecks({ ...base, tokenUri: httpUri, expectedUri: httpUri });
    expect(checks[2]?.passed).toBe(false);
  });
});

describe("formatVerificationLine", () => {
  it("通过项渲染成 PASS 开头", () => {
    expect(formatVerificationLine({ label: "L", passed: true, detail: "D" })).toBe("PASS L（D）");
  });

  it("失败项渲染成 FAIL 开头", () => {
    expect(formatVerificationLine({ label: "L", passed: false, detail: "D" })).toBe("FAIL L（D）");
  });
});

describe("parseAgentId", () => {
  it("十进制整数解析成 bigint", () => {
    expect(parseAgentId(" 851930 ")).toBe(851_930n);
  });

  it("空值报错", () => {
    expect(() => parseAgentId(undefined)).toThrow(ChainError);
  });

  it("非十进制报错", () => {
    expect(() => parseAgentId("0x1f")).toThrow(ChainError);
  });
});

describe("assertAgentCard", () => {
  const CARD = { type: REGISTRATION_TYPE, name: "Citely Deal Desk", disclaimer: "不构成法律意见" };

  it("合法 card 通过并返回 name", () => {
    expect(assertAgentCard(CARD, URI)).toBe("Citely Deal Desk");
  });

  it("空对象不通过：只看「200 + JSON」会被任何端点骗过", () => {
    expect(() => assertAgentCard({}, URI)).toThrow(/registration-v1/);
  });

  it("数组、null、字符串都不是 card", () => {
    expect(() => assertAgentCard([], URI)).toThrow(ChainError);
    expect(() => assertAgentCard(null, URI)).toThrow(ChainError);
    expect(() => assertAgentCard("card", URI)).toThrow(ChainError);
  });

  it("type 不是 registration-v1 不通过", () => {
    expect(() => assertAgentCard({ ...CARD, type: "https://example.com/other" }, URI)).toThrow(
      /registration-v1/,
    );
  });

  it("name 空白不通过", () => {
    expect(() => assertAgentCard({ ...CARD, name: "   " }, URI)).toThrow(/name/);
  });

  it("缺 disclaimer 不通过（对外身份必须带免责声明）", () => {
    expect(() => assertAgentCard({ type: CARD.type, name: CARD.name }, URI)).toThrow(/disclaimer/);
  });
});

describe("summarizeAgentCard", () => {
  const CARD: Record<string, unknown> = {
    type: REGISTRATION_TYPE,
    name: "Citely Deal Desk",
    description: "跨境交易可结算性预检",
    disclaimer: "本输出不构成法律意见",
    services: [
      { name: "web", endpoint: "https://deal-desk.example.com/" },
      { name: "x402", endpoint: "https://deal-desk.example.com/cases" },
    ],
    x402Support: true,
  };

  it("摘要覆盖人要核对的字段", () => {
    const lines = summarizeAgentCard(CARD, 1234).join("\n");
    expect(lines).toContain("Citely Deal Desk");
    expect(lines).toContain(REGISTRATION_TYPE);
    expect(lines).toContain("不构成法律意见");
    // endpoint 必须逐字完整，绝不截断——截断过的 URL 核对不了。
    expect(lines).toContain("service[x402] : https://deal-desk.example.com/cases");
    expect(lines).toContain("1234 字节");
  });

  it("超长字段截断，不刷屏", () => {
    const lines = summarizeAgentCard({ ...CARD, description: "长".repeat(500) }, 10);
    const description = lines.find((line) => line.startsWith("description"));
    expect(description).toMatch(/…$/);
    expect(description?.length).toBeLessThan(120);
  });

  it("换行与多余空白压平成一行", () => {
    const lines = summarizeAgentCard({ ...CARD, disclaimer: "第一行\n\n  第二行" }, 10);
    expect(lines.find((line) => line.startsWith("disclaimer"))).toContain("第一行 第二行");
  });

  it("首次注册时如实标注「无 registrations」", () => {
    expect(summarizeAgentCard(CARD, 10).join("\n")).toContain("（无，首次注册应如此）");
  });

  it("card 已带 registrations 时原样列出（提示这可能是上次注册留下的）", () => {
    const withRegistration = { ...CARD, registrations: [{ agentId: 851930 }] };
    expect(summarizeAgentCard(withRegistration, 10).join("\n")).toContain("851930");
  });

  it("endpoint 再长也不截断", () => {
    const long = `https://deal-desk.example.com/${"a".repeat(200)}`;
    const lines = summarizeAgentCard({ ...CARD, services: [{ name: "web", endpoint: long }] }, 10);
    expect(lines.join("\n")).toContain(long);
  });

  it("services 缺失或形状异常也不崩", () => {
    expect(summarizeAgentCard({ ...CARD, services: undefined }, 10).join("\n")).toContain("（无）");
    expect(summarizeAgentCard({ ...CARD, services: [null] }, 10).join("\n")).toContain("形状异常");
  });
});

describe("lookupRegistration", () => {
  it("balanceOf 为 0 → none（可以注册）", async () => {
    await expect(lookupRegistration(makeClient({ balance: 0n }), REGISTRY, OWNER)).resolves.toEqual({
      kind: "none",
    });
  });

  it("balanceOf > 0 但没给 ID → unknown-id（本注册表查不出 ID，不猜）", async () => {
    await expect(lookupRegistration(makeClient({ balance: 3n }), REGISTRY, OWNER)).resolves.toEqual({
      kind: "unknown-id",
      balance: 3n,
    });
  });

  it("给了 ID 且持有者相符 → known，带回链上现有 URI", async () => {
    const client = makeClient({ owner: OWNER, tokenUri: URI });
    await expect(lookupRegistration(client, REGISTRY, OWNER, 851_930n)).resolves.toEqual({
      kind: "known",
      agentId: 851_930n,
      tokenUri: URI,
    });
  });

  it("持有者大小写不同仍算相符", async () => {
    const client = makeClient({ owner: OWNER.toUpperCase() as Address });
    await expect(lookupRegistration(client, REGISTRY, OWNER, 1n)).resolves.toMatchObject({
      kind: "known",
    });
  });

  it("ID 属于别人 → 报错（别人的身份不能拿来当自己的）", async () => {
    const other = "0x2222222222222222222222222222222222222222" as Address;
    await expect(
      lookupRegistration(makeClient({ owner: other }), REGISTRY, OWNER, 1n),
    ).rejects.toThrow(/持有者是/);
  });

  it("ID 不存在 → 报错并指出可能填错了注册表", async () => {
    await expect(
      lookupRegistration(makeClient({ ownerOfReverts: true }), REGISTRY, OWNER, 1n),
    ).rejects.toThrow(/不存在/);
  });
});

describe("registerCall / setAgentUriCall / encodeRegistryCall", () => {
  it("register 带一个 URI 参数", () => {
    expect(registerCall(URI)).toEqual({ functionName: "register", args: [URI] });
  });

  it("setAgentURI 带 agentId + 新 URI", () => {
    expect(setAgentUriCall(7n, URI)).toEqual({ functionName: "setAgentURI", args: [7n, URI] });
  });

  it("两种动作编出不同的 4 字节选择器", () => {
    const registerData = encodeRegistryCall(registerCall(URI));
    const updateData = encodeRegistryCall(setAgentUriCall(7n, URI));
    expect(registerData.slice(0, 10)).not.toBe(updateData.slice(0, 10));
    expect(registerData).toMatch(/^0x[0-9a-f]+$/);
  });

  it("calldata 里含 URI 的十六进制编码（人可核对）", () => {
    const hex = Buffer.from(URI, "utf8").toString("hex");
    expect(encodeRegistryCall(registerCall(URI))).toContain(hex);
  });
});

describe("sendRegistryCall", () => {
  function makeClients(): { clients: ChainClients; calls: Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    const stub = {
      account: { address: OWNER },
      walletClient: {
        chain: { id: 5042002 },
        writeContract: async (request: Record<string, unknown>): Promise<`0x${string}`> => {
          calls.push(request);
          return `0x${"cd".repeat(32)}`;
        },
      },
    };
    return { clients: stub as unknown as ChainClients, calls };
  }

  it("register 走 register 分支并带上 URI", async () => {
    const { clients, calls } = makeClients();
    await expect(sendRegistryCall(clients, REGISTRY, registerCall(URI))).resolves.toMatch(/^0x/);
    expect(calls[0]).toMatchObject({ functionName: "register", args: [URI], address: REGISTRY });
  });

  it("setAgentURI 走 setAgentURI 分支并带上 agentId", async () => {
    const { clients, calls } = makeClients();
    await sendRegistryCall(clients, REGISTRY, setAgentUriCall(9n, URI));
    expect(calls[0]).toMatchObject({ functionName: "setAgentURI", args: [9n, URI] });
  });
});

describe("resolveExpectedOwner", () => {
  const KEY = `0x${"11".repeat(32)}` as const;

  it("显式地址优先，且不需要私钥", () => {
    expect(resolveExpectedOwner(OWNER, undefined)).toBe(getAddress(OWNER));
  });

  it("非法显式地址报错", () => {
    expect(() => resolveExpectedOwner("0xnope", undefined)).toThrow(ChainError);
  });

  it("没给地址时从私钥派生，且结果稳定", () => {
    const derived = resolveExpectedOwner(undefined, KEY);
    expect(derived).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(resolveExpectedOwner("", KEY)).toBe(derived);
  });

  it("地址与私钥都没有时报错", () => {
    expect(() => resolveExpectedOwner(undefined, undefined)).toThrow(/ERC8004_REGISTRAR_ADDRESS/);
  });
});

describe("arcscanTxUrl", () => {
  it("拼出 Arc 测试网浏览器链接", () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    expect(arcscanTxUrl(hash)).toBe(`https://testnet.arcscan.app/tx/${hash}`);
  });
});
