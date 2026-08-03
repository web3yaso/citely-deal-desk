/**
 * 主服务进程入口（Railway `start` 脚本指向本文件）。
 *
 * 装配顺序：读配置 → 打开案件库 → 建链上/采购/判定器依赖 → 接三检端口 →
 * 起 HTTP。任何一步失败都**响亮中止**，绝不带着半截配置起服务——
 * 一个"起来了但收不到钱/签不了 SA"的服务比起不来更危险。
 */

import {
  ARC_TESTNET,
  createArcPublicClient,
  createArcTransport,
  createChainClients,
  createGatewayClient,
  createJobClient,
  createPaidRoute,
  createX402Client,
  loadDotEnvFile,
  PaidRetryStore,
  paymentCredentialId,
  readPaymentCredential,
  redactSecrets,
  safeErrorMessage,
} from "@citely/chain";
import { createLogger, findRepoRoot, loadRubric, usdc6FromDecimal } from "@citely/engine";
import {
  CaseRunStore,
  PurchaseStore,
  runCase,
} from "@citely/engine/orchestrator";
import { createAdjudicatorLLM, FileGoldenCache, parseAdjudicatorMode } from "@citely/engine/adjudicator";
import { CaseStore, openDatabase, resolveDbPath, SqliteIdempotencyStore } from "@citely/engine/db";
import { LedgerStore } from "@citely/engine/ledger";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "./app.js";
import { createCaseReader } from "./case-reader.js";
import { createCaseRunner } from "./case-runner.js";
import { loadServerConfig, sellerPriceUsdc, ServerConfigError } from "./config.js";
import type { ServerConfig } from "./config.js";
import { createDemoApi } from "./demo-api.js";
import { readVerifierKey } from "@citely/verifier";

import { createInProcessVerifier } from "./in-process-verifier.js";
import type { PaymentGate, PaymentReceipt } from "./ports.js";

const log = createLogger("server");

/** 判定器 golden cache 目录名（与演示脚本共用同一份缓存）。 */
/**
 * 相对**仓库根**解析，不信进程 cwd——`pnpm --filter @citely/server start` 的
 * cwd 是 packages/server，裸相对路径会把缓存写进 packages/server/demo/，
 * 与 demo 脚本各存一份、命中率归零（DB_PATH 当年就是这个坑）。
 */
const GOLDEN_DIR = join(findRepoRoot(), "demo/golden/adjudication");

function buildJobClient(
  config: ServerConfig,
  verifierKey: `0x${string}`,
  txLog: SqliteIdempotencyStore,
) {
  const rpc = config.rpcUrl === undefined ? {} : { primaryUrl: config.rpcUrl };
  const rpcConfig = { primaryUrl: config.rpcUrl ?? "https://rpc.testnet.arc.network", ...rpc };
  return createJobClient({
    jobContract: config.jobContract,
    usdc: config.usdc,
    publicClient: createArcPublicClient(rpcConfig),
    wallets: {
      // 8183 client 角色用客户钱包；chain 的 WalletRole 没有 client 档，
      // 所以这一把自行构造，**不借用别的角色名**。
      client: createWalletClient({
        account: privateKeyToAccount(config.keys.marketplace),
        chain: ARC_TESTNET,
        transport: createArcTransport(rpcConfig),
      }),
      provider: createChainClients("operator", config.keys.operator, rpcConfig).walletClient,
      evaluator: createChainClients("verifier", verifierKey, rpcConfig).walletClient,
    },
    // 跨进程幂等：重跑同一案件不重发链上交易，必须是持久化实现。
    // **实例由 main() 建、这里只接收**：demo 的只读端点要读同一份 tx_log，
    // 两个实例就是两份状态、两个真相。
    store: txLog,
  });
}

function buildPaymentGate(config: ServerConfig): {
  gate: PaymentGate | undefined;
  readPayment: (request: Request) => PaymentReceipt | undefined;
} {
  if (config.seller.mode === "off") {
    log.warn("x402 收费未开启（X402_SELL_MODE=off）：本服务当前免费提供判定");
    return { gate: undefined, readPayment: () => undefined };
  }
  const gate = createPaidRoute({
    config: config.seller,
    path: "/cases",
    description: "Citely Deal Desk：一笔跨境付款的 Settlement Authorization",
    retryStore: new PaidRetryStore(),
    onError: (error) => {
      log.error("x402 收款链路失败", { error: safeErrorMessage(error) });
    },
  });
  return {
    gate,
    readPayment: (request) => {
      const credential = readPaymentCredential(request);
      // 只留凭证 ID，**不留签名材料**：它会进案件记录并可能被回显。
      return credential === undefined ? undefined : { credentialId: paymentCredentialId(credential) };
    },
  };
}

async function main(): Promise<void> {
  // 本地开发从仓库根 `.env` 取值；Railway 上直接注入环境变量，此处读不到文件也无妨
  // （`loadDotEnvFile` 对缺失文件是静默的，且**不覆盖**已存在的环境变量，
  //  所以平台注入的值永远优先于文件）。
  loadDotEnvFile(join(findRepoRoot(), ".env"));
  const config = loadServerConfig();

  if (config.verifier.mode === "remote") {
    // 远端验证器是目标形态，但当前被 chain 的接口卡住：`createJobClient` 要求
    // 三把钱包齐全（`JobRoleWallets.evaluator` 是必填），主服务因此仍然被迫
    // 持有验证器私钥——那样"独立密钥"就是假的。**宁可不启动，也不假装拆开了。**
    throw new ServerConfigError(
      "远端验证器模式尚未打通：chain 的 JobRoleWallets.evaluator 目前是必填，" +
        "主服务无法在不持有 VERIFIER_PRIVATE_KEY 的情况下构造 JobClient。" +
        "在 chain 把该字段改为可选之前，请用 VERIFIER_MODE=in-process（仅限本地联调）",
    );
  }

  // 进程内模式：**同一进程持有全部密钥**，"独立验证器、独立密钥"在此模式下不成立。
  process.stderr.write(
    "⚠️  VERIFIER_MODE=in-process：验证器与主服务在同一进程、共用同一套环境，\n" +
      "    「独立验证器、独立密钥」这条对外主张在本模式下**不成立**。仅供本地联调。\n",
  );

  // 库路径走 engine 的**唯一入口**（读 `DB_PATH`，相对路径锚仓库根）。
  // 早先这里传的是 `{ explicitPath }`，而该函数第一个参数是 env——
  // 于是自定义路径被静默忽略、永远落到默认库。Railway 挂卷会因此完全不生效。
  const dbPath = resolveDbPath(process.env);
  const db = openDatabase(dbPath);
  log.info("case store opened", { path: dbPath });

  // 进程内模式下这把钥匙确实要被本进程读到——正因如此它只允许本地联调。
  // 读取走 verifier 包的唯一出口（它带着那份"只读这一把"的负向测试）。
  const { privateKey: verifierKey } = readVerifierKey();
  // 链上写的幂等存储：JobClient 写、demo 只读端点读，**同一个实例**。
  const txLog = new SqliteIdempotencyStore(db);
  const jobClient = buildJobClient(config, verifierKey, txLog);
  const verifier = createInProcessVerifier({ jobClient, chainId: config.chainId });

  // 路径已在配置层解析成绝对路径并确认存在（相对路径锚仓库根，不看 cwd）。
  const rubric = loadRubric(config.rubricPath);

  const llm = createAdjudicatorLLM(process.env);
  const deps = {
    jobClient,
    stores: {
      cases: new CaseStore(db),
      ledger: new LedgerStore(db),
      runs: new CaseRunStore(db),
      purchases: new PurchaseStore(db),
    },
    adjudicator: {
      llm,
      cache: new FileGoldenCache({
        dir: GOLDEN_DIR,
        provider: llm.fingerprint.provider,
        model: llm.fingerprint.model,
      }),
      mode: parseAdjudicatorMode(process.env["ADJUDICATOR_MODE"]),
    },
    x402: createX402Client({
      baseUrl: config.msbAgentBaseUrl,
      gateway: createGatewayClient(config.keys.procurement, config.rpcUrl),
    }),
    operatorAccount: privateKeyToAccount(config.keys.operator),
    verify: verifier.verify,
    settle: verifier.settle,
    logger: log,
  };

  const payment = buildPaymentGate(config);
  const app = createApp({
    caseRunner: createCaseRunner(runCase, deps, {
      provider: privateKeyToAccount(config.keys.operator).address,
      evaluator: config.verifierAddress,
      caseBudget: config.caseBudget,
      // 不再 cast：`config.moduleId` 已在 loadServerConfig 里过 isModuleId 校验。
      moduleId: config.moduleId,
      modulePrice: config.modulePrice,
      chainId: config.chainId,
      rubric,
      // 出口 4 的升级材料配置，角色沿用 demo 先例（client=marketplace、
      // provider=operator、evaluator=verifier），保证金与 demo 同款 0.05。
      review: {
        client: privateKeyToAccount(config.keys.marketplace).address,
        provider: privateKeyToAccount(config.keys.operator).address,
        evaluator: config.verifierAddress,
        deposit: usdc6FromDecimal("0.05"),
      },
    }),
    caseReader: createCaseReader(deps.stores),
    ...(payment.gate === undefined ? {} : { paymentGate: payment.gate }),
    readPayment: payment.readPayment,
    // 演示 UI：/app 三件套 + encode/set-budget 口子。全公开信息，不进 agent card。
    demo: createDemoApi({
      jobClient: deps.jobClient,
      txLog,
      config: {
        chainId: config.chainId,
        jobContract: config.jobContract,
        usdc: config.usdc,
        provider: privateKeyToAccount(config.keys.operator).address,
        evaluator: config.verifierAddress,
        caseBudget: config.caseBudget,
      },
    }),
    card: {
      baseUrl: config.publicBaseUrl,
      // **换算成 USDC 再上卡片**：chain 给的是最小单位，直接填等于报价放大一百万倍。
      priceUsdc: sellerPriceUsdc(config.seller),
      payTo: config.seller.mode === "off" ? null : config.seller.payTo,
      chainId: config.chainId,
      ...(config.agentId === undefined ? {} : { agentId: config.agentId }),
      ...(config.identityRegistry === undefined
        ? {}
        : { identityRegistry: config.identityRegistry }),
    },
    logger: log,
  });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info("server listening", { port: info.port, publicBaseUrl: config.publicBaseUrl });
  });
}

try {
  await main();
} catch (error: unknown) {
  // 响亮失败：不吞错、不降级、不泄密。
  log.error("server aborted", { error: safeErrorMessage(error) });
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\n✗ 服务启动中止：${redactSecrets(detail)}\n`);
  process.exitCode = 1;
}
