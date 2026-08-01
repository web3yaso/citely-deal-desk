/**
 * ERC-8004 注册结果的链上闭环校验：链上读回来的东西必须和我们以为写进去的一致。
 *
 * 三项：`ownerOf` 是不是注册钱包、`tokenURI` 是不是那串 agentURI、URI 是不是 HTTPS，
 * 外加 agentURI 当下是否仍然公开可达（服务掉线时注册信息等于失效）。
 *
 * 只读脚本：默认**不碰私钥**——用 `ERC8004_REGISTRAR_ADDRESS` 给出期望的 owner 即可；
 * 没给才回落到从 `OPERATOR_PRIVATE_KEY` 派生地址。
 *
 * 用法：
 *   node --import tsx scripts/verify-8004.ts [--uri <URI>] [--registry 0x...]
 *   Agent ID 取自 `ERC8004_AGENT_ID`（注册脚本的输出）。
 */
import { identityRegistryAbi } from "../packages/chain/src/abi/index.js";
import {
  ENV_KEYS,
  loadDotEnvFile,
  optionalEnv,
  readPrivateKey,
} from "../packages/chain/src/config/env.js";
import { safeErrorMessage } from "../packages/chain/src/config/redact.js";
import {
  buildCardClaimCheck,
  buildVerificationChecks,
  formatVerificationLine,
  parseAgentId,
  probeAgentCard,
  probeIdentityRegistry,
  resolveAgentUri,
  resolveExpectedOwner,
  resolveRegistryAddress,
} from "../packages/chain/src/erc8004.js";
import { ChainError } from "../packages/chain/src/errors.js";
import type { Address } from "../packages/chain/src/types/viem.js";
import { createArcPublicClient, type RpcConfig } from "../packages/chain/src/wallet.js";

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

/** 期望的 owner：显式地址优先，没给才回落到从运营私钥派生。 */
function expectedOwner(): Address {
  const configured = optionalEnv(process.env, "ERC8004_REGISTRAR_ADDRESS");
  return resolveExpectedOwner(
    configured,
    configured === undefined ? readPrivateKey(process.env, ENV_KEYS.operatorKey) : undefined,
  );
}

async function main(): Promise<void> {
  loadDotEnvFile(new URL("../.env", import.meta.url).pathname);
  const argv = process.argv.slice(2);
  const registry = resolveRegistryAddress(argv, optionalEnv(process.env, ENV_KEYS.identityRegistry));
  const agentUri = resolveAgentUri(argv, optionalEnv(process.env, ENV_KEYS.agentCardUrl));
  const agentId = parseAgentId(optionalEnv(process.env, ENV_KEYS.agentId));
  const client = createArcPublicClient(readRpc());

  await probeIdentityRegistry(client, registry);
  const [owner, tokenUri] = await Promise.all([
    client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    }),
    client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "tokenURI",
      args: [agentId],
    }),
  ]);

  write(`agentId=${agentId.toString()} @ ${registry}`);
  const checks = buildVerificationChecks({
    owner,
    expectedOwner: expectedOwner(),
    tokenUri,
    expectedUri: agentUri,
  });
  for (const check of checks) {
    write(formatVerificationLine(check));
  }

  const card = await probeAgentCard(tokenUri);
  write(`PASS 链上 agentURI 当前可达（HTTP ${String(card.status)} ${card.contentType}）`);

  // 反向断言：前面几项都是"链上 → card"，这一项是"card → 链上"。
  // 少了它，card 静默丢掉 registrations 时整个脚本照样全绿。
  const claimCheck = buildCardClaimCheck({
    registrations: card.registrations,
    agentId,
    registry,
    chainId: await client.getChainId(),
  });
  write(formatVerificationLine(claimCheck));

  if ([...checks, claimCheck].some((check) => !check.passed)) {
    throw new ChainError("链上闭环校验未全部通过：注册信息与预期不一致");
  }
  write("VERIFY-8004 OK");
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`VERIFY-8004 FAILED: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}
