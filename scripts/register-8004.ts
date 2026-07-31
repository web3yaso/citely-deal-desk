/**
 * ERC-8004 身份注册：把 Deal Desk 的 agentURI 写进 Identity Registry。**手动执行，不进 CI。**
 *
 * 注册的是**公开可达的 agent URI**——所以必须**先把服务部署出公网 URL**，
 * 再跑这个脚本；脚本在写链之前会真的 GET 一次那个 URI，404 就拒绝注册。
 *
 * 用哪把密钥：`OPERATOR_PRIVATE_KEY`（8183 provider 侧，也是 SA 的 EIP-712 签名者）。
 * 理由：8004 身份 = 对外署名的那个身份，和 SA 的签名者是同一个才自洽；
 * 另开一把新钥只会多一个要充 gas、要备份的钱包。身份 NFT 后续可 ERC-721 转移。
 *
 * 用法：
 *   node --import tsx scripts/register-8004.ts --uri https://<域名>/.well-known/agent-card.json
 *     └─ dry-run（默认，`--dry-run` 是它的显式写法）：GET 一次 agentURI 做可达性 +
 *        内容自检、打印取回内容摘要与 calldata，**不发交易**
 *        —— `--confirm` 就是"我核对过了，发吧"的显式同意
 *   node --import tsx scripts/register-8004.ts --uri <URI> --confirm
 *     └─ 真发 register 交易，输出 Agent ID 与 txHash
 *   node --import tsx scripts/register-8004.ts --uri <新URI> --update-uri --confirm
 *     └─ 改已注册 agent 的 URI（需要 ERC8004_AGENT_ID）；已实测该注册表支持 setAgentURI，
 *        且只有持有者能调——所以可以先用 Railway 默认域名注册，换自定义域名后再改一次
 *   可选 `--registry 0x...` 覆盖注册表地址；`--force` 明知已有身份仍再注册一个。
 *
 * **幂等**：注册前先查这把钥有没有注册过（`ERC8004_AGENT_ID` → `ownerOf`，
 * 否则 `balanceOf`）。已注册就打印既有 Agent ID 并**不发交易**。
 */
import {
  ENV_KEYS,
  loadDotEnvFile,
  optionalEnv,
  readPrivateKey,
} from "../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../packages/chain/src/config/redact.js";
import { formatUsdc } from "../packages/chain/src/diagnostics.js";
import {
  arcscanTxUrl,
  encodeRegistryCall,
  extractAgentId,
  lookupRegistration,
  parseAgentId,
  probeAgentCard,
  probeIdentityRegistry,
  registerCall,
  resolveAgentUri,
  resolveExpectedOwner,
  resolveRegistryAddress,
  sendRegistryCall,
  setAgentUriCall,
  type RegistrationLookup,
  type RegistryCall,
} from "../packages/chain/src/erc8004.js";
import { ChainError } from "../packages/chain/src/errors.js";
import type { Address } from "../packages/chain/src/types/viem.js";
import { createArcPublicClient, createChainClients } from "../packages/chain/src/wallet.js";
import type { RpcConfig } from "../packages/chain/src/wallet.js";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readRpc(): RpcConfig {
  const primaryUrl = optionalEnv(process.env, ENV_KEYS.rpcUrl);
  if (primaryUrl === undefined) {
    throw new ChainError(`未设置 ${ENV_KEYS.rpcUrl}`);
  }
  const fallbackUrl = optionalEnv(process.env, ENV_KEYS.rpcUrlFallback);
  return fallbackUrl === undefined ? { primaryUrl } : { primaryUrl, fallbackUrl };
}

/** 注册（或改 URI）要发的这笔调用。dry-run 也算出来，供人核对 calldata。 */
function buildCall(agentUri: string, isUpdate: boolean): RegistryCall {
  return isUpdate
    ? setAgentUriCall(parseAgentId(optionalEnv(process.env, ENV_KEYS.agentId)), agentUri)
    : registerCall(agentUri);
}

/**
 * 注册钱包地址：显式配置优先，其次从运营私钥派生。
 *
 * dry-run 下两者都没有时返回 `undefined`——那就查不了"是否已注册"，
 * 但也不该为了查这个硬要求 dry-run 持有私钥。
 */
function registrarAddress(): Address | undefined {
  const configured = optionalEnv(process.env, "ERC8004_REGISTRAR_ADDRESS");
  const key = optionalEnv(process.env, ENV_KEYS.operatorKey);
  if (configured === undefined && key === undefined) {
    return undefined;
  }
  return resolveExpectedOwner(
    configured,
    configured === undefined ? readPrivateKey(process.env, ENV_KEYS.operatorKey) : undefined,
  );
}

/**
 * 幂等闸门：已经注册过就别再注册一个。
 *
 * @returns `true` 表示可以继续注册，`false` 表示什么都不用做（幂等命中）
 */
async function idempotencyGate(
  registry: Address,
  agentUri: string,
  options: { readonly isUpdate: boolean; readonly force: boolean },
): Promise<boolean> {
  const owner = registrarAddress();
  if (owner === undefined) {
    write("⏳ 未配置 ERC8004_REGISTRAR_ADDRESS 也没有运营私钥：跳过「是否已注册」检查");
    return true;
  }
  const found = await lookupRegistration(
    createArcPublicClient(readRpc()),
    registry,
    owner,
    optionalEnv(process.env, ENV_KEYS.agentId) === undefined
      ? undefined
      : parseAgentId(optionalEnv(process.env, ENV_KEYS.agentId)),
  );
  return decideGate(found, agentUri, options);
}

function decideGate(
  found: RegistrationLookup,
  agentUri: string,
  options: { readonly isUpdate: boolean; readonly force: boolean },
): boolean {
  if (found.kind === "none") {
    if (options.isUpdate) {
      throw new ChainError("这把钥还没注册过任何 agent，没有 URI 可改：去掉 --update-uri");
    }
    return true;
  }
  if (found.kind === "unknown-id") {
    if (options.force) return true;
    throw new ChainError(
      `注册钱包已持有 ${found.balance.toString()} 个身份 NFT，但没给 ${ENV_KEYS.agentId}。` +
        "本注册表不支持 ERC721Enumerable（链上实测），公共 RPC 又限制日志范围 1 万区块——" +
        `Agent ID 只能由人从注册时的运行记录/交易回执取回，填进 ${ENV_KEYS.agentId} 再重跑。` +
        "确实要再注册一个新身份才加 --force。",
    );
  }
  write(`已注册：Agent ID=${found.agentId.toString()}`);
  write(`  链上现有 agentURI：${found.tokenUri}`);
  if (options.isUpdate) return true;
  write(
    found.tokenUri === agentUri
      ? "REGISTER-8004 无需操作：链上 URI 与目标 URI 完全一致（幂等命中，未发交易）"
      : "REGISTER-8004 未注册新身份：这把钥已有身份，要改 URI 请加 --update-uri（未发交易）",
  );
  return false;
}

/**
 * 解析"发不发交易"。
 *
 * 默认 dry-run；`--dry-run` 是把这个默认显式写出来的同义标志。
 * 两个一起给是自相矛盾的指令，宁可报错也不替人猜哪个优先。
 */
function resolveConfirm(argv: readonly string[]): boolean {
  const confirm = argv.includes("--confirm");
  if (confirm && argv.includes("--dry-run")) {
    throw new ChainError("--confirm 与 --dry-run 互斥：想发交易只留 --confirm");
  }
  return confirm;
}

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../.env", import.meta.url).pathname);
  const argv = process.argv.slice(2);
  const confirm = resolveConfirm(argv);
  const isUpdate = argv.includes("--update-uri");
  const force = argv.includes("--force");
  const registry = resolveRegistryAddress(argv, optionalEnv(process.env, ENV_KEYS.identityRegistry));
  const agentUri = resolveAgentUri(argv, optionalEnv(process.env, ENV_KEYS.agentCardUrl));

  const probe = await probeIdentityRegistry(createArcPublicClient(readRpc()), registry);
  write(`注册表：${probe.address}（${probe.name} / ${probe.symbol}）`);
  write(`  chainId=${String(probe.chainId)} 字节码=${String(probe.codeSize)} 字节`);

  // 真的 GET 一次：注册一个打不开的 URI 等于在链上留死链，补救要第二笔 gas。
  const card = await probeAgentCard(agentUri);
  write(`agentURI 自检：HTTP ${String(card.status)}，content-type=${card.contentType} ✅`);
  write("取回内容摘要（请人工核对——这就是你将公之于众的东西）：");
  for (const line of card.summary) {
    write(`  ${line}`);
  }
  // 这一行是给人核对的最后一道闸：写进链上的就是它，逐字。
  write(`⚠️ 将写入链上的 agentURI（请逐字核对）：${agentUri}`);

  if (!(await idempotencyGate(registry, agentUri, { isUpdate, force }))) {
    return;
  }

  const call = buildCall(agentUri, isUpdate);
  write(`动作：${call.functionName}`);
  write(`calldata=${encodeRegistryCall(call)}`);

  if (!confirm) {
    write("模式：dry-run（默认）—— 未发送任何交易。");
    write("以上摘要与 URI 逐字核对无误后，加 --confirm 重跑才会真正上链。");
    return;
  }
  await send(registry, call);
}

async function send(registry: Address, call: RegistryCall): Promise<void> {
  // 只在真发交易这一步才碰私钥：dry-run 不需要、也不该持有密钥。
  const clients = createChainClients(
    "operator",
    readPrivateKey(process.env, ENV_KEYS.operatorKey),
    readRpc(),
  );
  const balance = await clients.publicClient.getBalance({ address: clients.address });
  write(`注册钱包（OPERATOR，请人工核对）：${clients.address}`);
  write(`  gas 余额：${formatUsdc(balance)}`);
  if (balance === 0n) {
    throw new ChainError("注册钱包余额为 0，先去 https://faucet.circle.com 领 Arc Testnet 资金");
  }

  const hash = await sendRegistryCall(clients, registry, call);
  write(`txHash=${hash}`);
  write(arcscanTxUrl(hash));
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new ChainError(`交易上链但执行失败（status=${receipt.status}）：${hash}`);
  }
  if (call.functionName === "setAgentURI") {
    write("REGISTER-8004 OK：agentURI 已更新");
    return;
  }
  const agentId = extractAgentId(receipt.logs, registry);
  write(`agentId=${agentId.toString()}`);
  write(`下一步：把 ${ENV_KEYS.agentId}=${agentId.toString()} 填进 .env，再跑 verify-8004.ts`);
}

try {
  await main();
} catch (error: unknown) {
  // 私钥已在 readPrivateKey 时登记；SDK 报错即使回显私钥也会在这里被替换掉。
  process.stderr.write(`REGISTER-8004 FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
