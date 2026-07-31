import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { identityRegistryAbi } from "./abi/identity-registry.js";
import { ChainError, wrapChainError } from "./errors.js";
import { ARC_TESTNET, type ChainClients } from "./wallet.js";

/** Arc Testnet 上的 ERC-8004 Identity Registry（合约 §8 已记录，实测可用）。 */
export const DEFAULT_IDENTITY_REGISTRY: Address = getAddress(
  "0x8004A818BFB912233c491871b3d84c89A494BD9e",
);

/** ERC-721 的 `interfaceId`。注册表本体是 NFT，不支持它就说明地址找错了。 */
export const ERC721_INTERFACE_ID = "0x80ac58cd";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * 取注册表地址：`--registry 0x...` > 环境变量 > {@link DEFAULT_IDENTITY_REGISTRY}。
 *
 * @param argv - `process.argv.slice(2)`
 * @param envValue - `ERC8004_IDENTITY_REGISTRY` 的值
 */
export function resolveRegistryAddress(
  argv: readonly string[],
  envValue: string | undefined,
): Address {
  const flagIndex = argv.indexOf("--registry");
  const fromFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const raw = (fromFlag ?? envValue)?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_IDENTITY_REGISTRY;
  }
  if (!isAddress(raw, { strict: false })) {
    throw new ChainError(`ERC-8004 注册表地址不是合法 EVM 地址：${raw}`);
  }
  return getAddress(raw);
}

/**
 * 取要写上链的 agentURI：`--uri <url>` > 环境变量 `AGENT_CARD_URL`。
 *
 * 必须是 **HTTPS 公网地址**：这串字符会永久写进链上、被别的 agent 拿去解析，
 * 写错就得再发一笔 `setAgentURI` 才能改。因此不接受 localhost，也不接受 http。
 *
 * @param argv - `process.argv.slice(2)`
 * @param envValue - `AGENT_CARD_URL` 的值
 */
export function resolveAgentUri(argv: readonly string[], envValue: string | undefined): string {
  const flagIndex = argv.indexOf("--uri");
  const fromFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const raw = (fromFlag ?? envValue)?.trim();
  if (raw === undefined || raw === "") {
    throw new ChainError(
      "缺少 agentURI：用 --uri https://<服务域名>/.well-known/agent-card.json 传入，" +
        "或先把 AGENT_CARD_URL 填进 .env（服务部署出公网 URL 之后才能注册）",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    throw new ChainError(`agentURI 不是合法 URL：${raw}`, {}, { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new ChainError(`agentURI 必须是 HTTPS 公网地址（链上不可轻易改）：${raw}`);
  }
  return url.toString();
}

/** Agent Card 的可达性探测结果。 */
export interface AgentCardProbe {
  readonly uri: string;
  readonly status: number;
  readonly contentType: string;
  /** card 里的 `name`，打印出来供人确认"这确实是我们那张 card"。 */
  readonly name: string;
  /** 取回内容的逐行摘要，注册前打印给人核对（见 {@link summarizeAgentCard}）。 */
  readonly summary: readonly string[];
}

/** 只用到 `fetch` 的这点能力，测试注入假实现即可（零网络）。 */
export type FetchLike = (input: string) => Promise<Response>;

/** EIP-8004 registration-v1 的 `type` 字面量（msb-agent 线上 card 实测一致）。 */
export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/**
 * 校验一份 agent card 的**内容**（不只是"能打开"）。
 *
 * 只认三样必需品，都是对外身份的最低要求：registration-v1 的 `type`、
 * 非空 `name`、字符串 `disclaimer`（诚实性要求，服务设计 §4）。
 * 随便一个返回 `{}` 的 JSON 端点都能骗过"200 + JSON"，但骗不过这三项。
 *
 * @param body - 已解析的响应体
 * @param uri - 出错消息里指认是哪个 URI
 * @returns card 的 `name`
 */
export function assertAgentCard(body: unknown, uri: string): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ChainError(`agentURI 返回的不是 JSON 对象（${uri}）：不是一张 agent card`);
  }
  const card = body as Record<string, unknown>;
  if (card.type !== REGISTRATION_TYPE) {
    throw new ChainError(
      `agentURI 的 type 不是 ERC-8004 registration-v1（${uri}）：${String(card.type)}`,
    );
  }
  const name = card.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new ChainError(`agent card 缺少非空 name（${uri}）`);
  }
  if (typeof card.disclaimer !== "string") {
    throw new ChainError(`agent card 缺少 disclaimer（${uri}）：对外身份必须带免责声明`);
  }
  return name;
}

/** 摘要里每个字段的截断长度：够认出来，又不至于把整张 card 刷屏。 */
const SUMMARY_FIELD_MAX = 72;

function clip(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= SUMMARY_FIELD_MAX ? flat : `${flat.slice(0, SUMMARY_FIELD_MAX)}…`;
}

/**
 * `services` 里的 endpoint，**每个一行且不截断**。
 *
 * 别人真正会去点的就是这些地址：截断过的 URL 核对不了，等于没打印。
 */
function summarizeServices(services: unknown): readonly string[] {
  if (!Array.isArray(services) || services.length === 0) {
    return ["service     : （无）"];
  }
  return services.map((service) => {
    if (typeof service !== "object" || service === null) {
      return "service     : （形状异常，不是对象）";
    }
    const entry = service as Record<string, unknown>;
    return `service[${String(entry.name ?? "?")}] : ${String(entry.endpoint ?? "?")}`;
  });
}

/**
 * 把取回的 card 渲染成**给人核对**的逐行摘要。
 *
 * 注册是要花 gas、写进链上、且会被人顺着点开的动作。摘要的目的只有一个：
 * 让核对的人在**掏钱之前**看清自己将把什么公之于众。
 *
 * @param card - 已通过 {@link assertAgentCard} 的 card
 * @param byteLength - 原始正文字节数
 */
export function summarizeAgentCard(
  card: Record<string, unknown>,
  byteLength: number,
): readonly string[] {
  const registrations = card.registrations;
  return [
    `name        : ${clip(String(card.name))}`,
    `type        : ${clip(String(card.type))}`,
    `description : ${clip(String(card.description ?? "（无）"))}`,
    `disclaimer  : ${clip(String(card.disclaimer))}`,
    ...summarizeServices(card.services),
    `x402Support : ${String(card.x402Support ?? "（未声明）")}`,
    // 首次注册时链上还没有 ID，card 里理应还没有 registrations；
    // 已经有了通常意味着这张 card 是上一次注册留下的，值得人多看一眼。
    `registrations: ${Array.isArray(registrations) ? JSON.stringify(registrations) : "（无，首次注册应如此）"}`,
    `正文        : ${String(byteLength)} 字节，${String(Object.keys(card).length)} 个顶层字段`,
  ];
}

/**
 * 注册前确认 agentURI 真的公开可达，**且内容确实是我们的 agent card**。
 *
 * 链上写一个打不开（或打开了不是 card）的 URI 等于注册了个死链，
 * 而改它要再花一笔 gas——所以宁可在写之前失败。
 *
 * @param uri - {@link resolveAgentUri} 的结果
 * @param fetchImpl - HTTP 客户端，默认全局 `fetch`
 */
export async function probeAgentCard(
  uri: string,
  fetchImpl: FetchLike = fetch,
): Promise<AgentCardProbe> {
  let response: Response;
  try {
    response = await fetchImpl(uri);
  } catch (error: unknown) {
    throw wrapChainError(error, `agentURI 不可达（${uri}）：公网访问不到就不该写上链`);
  }
  if (!response.ok) {
    throw new ChainError(`agentURI 返回 HTTP ${String(response.status)}（${uri}）`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new ChainError(`agentURI 的 content-type 不是 JSON（${uri}）：${contentType}`);
  }
  // 读 text 而不是 json：既要原始字节数进摘要，也要在解析失败时能说清是哪一段坏了。
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (error: unknown) {
    throw wrapChainError(error, `agentURI 返回的 JSON 解析失败（${uri}）`);
  }
  const name = assertAgentCard(body, uri);
  return {
    uri,
    status: response.status,
    contentType,
    name,
    summary: summarizeAgentCard(body as Record<string, unknown>, Buffer.byteLength(raw, "utf8")),
  };
}

/** Identity Registry 的探测结论，注册前打印给人核对。 */
export interface IdentityRegistryProbe {
  readonly address: Address;
  readonly chainId: number;
  readonly codeSize: number;
  readonly name: string;
  readonly symbol: string;
}

/**
 * 探测 Identity Registry：链对不对、地址上有没有合约、是不是 ERC-721。
 *
 * 三项任一不过就抛错——在错的合约上发 `register` 只会浪费 gas 或写进错的账本。
 *
 * @param client - Arc Testnet 公共客户端
 * @param registry - 注册表地址
 */
export async function probeIdentityRegistry(
  client: PublicClient<Transport, Chain>,
  registry: Address,
): Promise<IdentityRegistryProbe> {
  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET.id) {
    throw new ChainError(
      `RPC 指向的不是 Arc Testnet：chainId ${String(chainId)} ≠ ${String(ARC_TESTNET.id)}`,
    );
  }
  const code = await client.getCode({ address: registry });
  if (code === undefined || code === "0x") {
    throw new ChainError(`Identity Registry 地址上没有合约：${registry}`);
  }
  const [supportsErc721, name, symbol] = await Promise.all([
    client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "supportsInterface",
      args: [ERC721_INTERFACE_ID],
    }),
    client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "name" }),
    client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "symbol" }),
  ]);
  if (!supportsErc721) {
    throw new ChainError(`目标合约不支持 ERC-721（${registry}）：不是 ERC-8004 注册表`);
  }
  return { address: registry, chainId, codeSize: (code.length - 2) / 2, name, symbol };
}

/** `extractAgentId` 需要的最小日志形状。 */
export type MintLog = Pick<Log, "address" | "data" | "topics">;

/**
 * 从注册交易回执里取 Agent ID = 铸造那条 `Transfer(from=0x0)` 的 tokenId。
 *
 * `register` 的返回值拿不到（写交易只回 txHash），只能从事件里解。
 *
 * @param logs - 回执里的全部日志
 * @param registry - 注册表地址，用来过滤掉别的合约的日志
 */
export function extractAgentId(logs: readonly MintLog[], registry: Address): bigint {
  for (const log of logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) {
      continue;
    }
    const tokenId = decodeMintTokenId(log);
    if (tokenId !== undefined) {
      return tokenId;
    }
  }
  throw new ChainError("注册交易成功但回执里没有铸造 Transfer 日志：Agent ID 无法确认");
}

/** 解一条日志：是铸造 `Transfer` 就返回 tokenId，否则 `undefined`。 */
function decodeMintTokenId(log: MintLog): bigint | undefined {
  try {
    const event = decodeEventLog({
      abi: identityRegistryAbi,
      data: log.data,
      topics: log.topics,
    });
    if (event.eventName === "Transfer" && event.args.from.toLowerCase() === ZERO_ADDRESS) {
      return event.args.tokenId;
    }
    return undefined;
  } catch {
    // 同一合约还会发别的事件，解不出来是预期内的（不是错误），跳过即可。
    return undefined;
  }
}

/** 一条链上闭环校验。 */
export interface VerificationCheck {
  readonly label: string;
  readonly passed: boolean;
  /** 不通过时告诉人实际读到了什么。 */
  readonly detail: string;
}

export interface VerificationInput {
  readonly owner: Address;
  readonly expectedOwner: Address;
  readonly tokenUri: string;
  readonly expectedUri: string;
}

/**
 * 组装注册结果的链上闭环校验项：所有权归注册钱包、URI 与预期逐字一致、URI 是 HTTPS。
 *
 * @param input - 链上读到的值与预期值
 */
export function buildVerificationChecks(input: VerificationInput): readonly VerificationCheck[] {
  const ownerMatches = input.owner.toLowerCase() === input.expectedOwner.toLowerCase();
  const uriMatches = input.tokenUri === input.expectedUri;
  return [
    {
      label: "ownerOf 等于注册钱包",
      passed: ownerMatches,
      detail: `链上 ${input.owner} / 预期 ${input.expectedOwner}`,
    },
    {
      label: "tokenURI 等于 agentURI",
      passed: uriMatches,
      detail: `链上 ${input.tokenUri} / 预期 ${input.expectedUri}`,
    },
    {
      label: "链上 agentURI 是 HTTPS",
      passed: input.tokenUri.startsWith("https://"),
      detail: input.tokenUri,
    },
  ];
}

/** 把一条校验渲染成 `PASS/FAIL 标签（细节）` 一行。 */
export function formatVerificationLine(check: VerificationCheck): string {
  return `${check.passed ? "PASS" : "FAIL"} ${check.label}（${check.detail}）`;
}

/** 解析 `ERC8004_AGENT_ID`：必须是十进制非负整数。 */
export function parseAgentId(raw: string | undefined): bigint {
  const value = raw?.trim();
  if (value === undefined || value === "" || !/^\d+$/.test(value)) {
    throw new ChainError(
      `ERC8004_AGENT_ID 必须是十进制整数（注册脚本输出的 Agent ID）：${String(raw)}`,
    );
  }
  return BigInt(value);
}

/**
 * 注册钱包在注册表上的既有身份。
 *
 * 三态，对应链上能查到的三种确定程度——**不假装能查到查不到的东西**：
 *
 * - `none`：`balanceOf` 为 0，这把钥没注册过，可以注册；
 * - `known`：拿着 `ERC8004_AGENT_ID` 核对 `ownerOf` 成功，ID 与 URI 都确定；
 * - `unknown-id`：`balanceOf` > 0 但没给 ID。**这个注册表查不出 ID**——
 *   实测 `supportsInterface(0x780e9d63)` 为 false（无 ERC721Enumerable），
 *   而扫 `Transfer` 日志被公共 RPC 的 1 万区块范围上限挡住（链高已 5000 万+）。
 *   此时必须由人从注册时的运行记录/交易回执取回 ID，脚本不猜。
 */
export type RegistrationLookup =
  | { readonly kind: "none" }
  | { readonly kind: "known"; readonly agentId: bigint; readonly tokenUri: string }
  | { readonly kind: "unknown-id"; readonly balance: bigint };

/**
 * 查这把注册钱包在注册表上的既有身份，用于**注册幂等**：已注册过就别再注册一个。
 *
 * @param client - Arc Testnet 公共客户端
 * @param registry - 注册表地址
 * @param owner - 注册钱包地址
 * @param agentId - 已知的 Agent ID（`ERC8004_AGENT_ID`），没有则不传
 */
export async function lookupRegistration(
  client: PublicClient<Transport, Chain>,
  registry: Address,
  owner: Address,
  agentId?: bigint,
): Promise<RegistrationLookup> {
  if (agentId !== undefined) {
    return lookupKnownAgent(client, registry, owner, agentId);
  }
  const balance = await client.readContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "balanceOf",
    args: [owner],
  });
  return balance === 0n ? { kind: "none" } : { kind: "unknown-id", balance };
}

/** 已知 ID 的分支：`ownerOf` 必须正好是这把钥，否则是配置串了，必须响亮失败。 */
async function lookupKnownAgent(
  client: PublicClient<Transport, Chain>,
  registry: Address,
  owner: Address,
  agentId: bigint,
): Promise<RegistrationLookup> {
  let onChainOwner: Address;
  try {
    onChainOwner = await client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    });
  } catch (error: unknown) {
    throw wrapChainError(
      error,
      `Agent ID ${agentId.toString()} 在注册表上不存在（${registry}）：` +
        "ERC8004_AGENT_ID 填错了，或它属于另一个注册表",
    );
  }
  if (onChainOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new ChainError(
      `Agent ID ${agentId.toString()} 的持有者是 ${onChainOwner}，不是本次的注册钱包 ${owner}：` +
        "别人的身份改不了，也不该拿来当自己的",
    );
  }
  const tokenUri = await client.readContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "tokenURI",
    args: [agentId],
  });
  return { kind: "known", agentId, tokenUri };
}

/** 要发给注册表的那笔写调用（判别联合，两种动作参数不同）。 */
export type RegistryCall =
  | { readonly functionName: "register"; readonly args: readonly [string] }
  | { readonly functionName: "setAgentURI"; readonly args: readonly [bigint, string] };

/** 首次注册：`register(agentURI)`，返回值（Agent ID）只能从事件里取。 */
export function registerCall(agentUri: string): RegistryCall {
  return { functionName: "register", args: [agentUri] };
}

/** 改已注册 agent 的 URI：`setAgentURI(agentId, newURI)`。 */
export function setAgentUriCall(agentId: bigint, agentUri: string): RegistryCall {
  return { functionName: "setAgentURI", args: [agentId, agentUri] };
}

/** 编码 calldata，dry-run 时打印给人核对（不发交易也能看清将写什么）。 */
export function encodeRegistryCall(call: RegistryCall): Hex {
  return call.functionName === "register"
    ? encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: call.args })
    : encodeFunctionData({ abi: identityRegistryAbi, functionName: "setAgentURI", args: call.args });
}

/**
 * 发出注册表写调用。
 *
 * 分支写两遍是必要的：viem 的 `writeContract` 按 `functionName` 精确校验 `args`，
 * 直接摊开联合类型过不了类型检查（也就失去了参数校验）。
 *
 * @param clients - 持注册钱包私钥的一组 client
 * @param registry - 注册表地址
 * @param call - {@link registerCall} 或 {@link setAgentUriCall} 的结果
 * @returns 交易哈希
 */
export async function sendRegistryCall(
  clients: ChainClients,
  registry: Address,
  call: RegistryCall,
): Promise<Hex> {
  if (call.functionName === "register") {
    return clients.walletClient.writeContract({
      account: clients.account,
      chain: clients.walletClient.chain,
      address: registry,
      abi: identityRegistryAbi,
      functionName: "register",
      args: call.args,
    });
  }
  return clients.walletClient.writeContract({
    account: clients.account,
    chain: clients.walletClient.chain,
    address: registry,
    abi: identityRegistryAbi,
    functionName: "setAgentURI",
    args: call.args,
  });
}

/**
 * 解析校验脚本里"期望的 owner"：显式地址优先，没给才从私钥派生。
 *
 * 只读校验不该平白持有私钥——所以显式地址是首选路径。
 *
 * @param configured - `ERC8004_REGISTRAR_ADDRESS` 的值
 * @param privateKey - 回落用的私钥（`OPERATOR_PRIVATE_KEY`）
 */
export function resolveExpectedOwner(
  configured: string | undefined,
  privateKey: Hex | undefined,
): Address {
  const raw = configured?.trim();
  if (raw !== undefined && raw !== "") {
    if (!isAddress(raw, { strict: false })) {
      throw new ChainError(`ERC8004_REGISTRAR_ADDRESS 不是合法 EVM 地址：${raw}`);
    }
    return getAddress(raw);
  }
  if (privateKey === undefined) {
    throw new ChainError(
      "无法确定期望的 owner：请设置 ERC8004_REGISTRAR_ADDRESS，或提供注册钱包私钥",
    );
  }
  return privateKeyToAccount(privateKey).address;
}

/** Arc Testnet 区块浏览器的交易链接。 */
export function arcscanTxUrl(txHash: Hex): string {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}
