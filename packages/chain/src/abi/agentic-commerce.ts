/**
 * ERC-8183「Agentic Commerce」参考实现 `AgenticCommerce` 的 ABI。
 *
 * 事实源：ethereum/ERCs 仓库 `ERCS/erc-8183.md` §Reference Implementation
 * （commit `a078cab5cc8e9581c15f76c091ed96eed28f02f7`，2026-03-13）。
 * 全部签名逐条对照该文件的 Solidity 源码抄写，未做任何增删。
 *
 * ⚠️ 三处与 v2.2 §2.1 / `contracts-vertical-slice.md` §2 文字描述不同，以参考实现为准：
 * 1. `fund` 的形参是 `(uint256 jobId, bytes optParams)`，**没有** `expectedBudget`；
 *    escrow 靠 `safeTransferFrom` 拉款，调用前必须先对本合约 `approve`。
 * 2. `setBudget` 只允许 **provider** 调用（`msg.sender != job.provider` 即 revert），
 *    规范正文写的"client 或 provider"没有落到参考实现里。
 * 3. 状态枚举有 **六** 个值，多出一个 `Expired`（claimRefund 后的终态）。
 */

/** `JobStatus` 枚举的链上取值顺序（参考实现 `enum JobStatus`）。 */
export const JOB_STATUS_NAMES = [
  "Open",
  "Funded",
  "Submitted",
  "Completed",
  "Rejected",
  "Expired",
] as const;

/** 链上 `JobStatus` 枚举名。 */
export type JobStatusName = (typeof JOB_STATUS_NAMES)[number];

export const agenticCommerceAbi = [
  // ──────────────────── Job Lifecycle ────────────────────
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint256" },
      { name: "description", type: "string" },
      { name: "hook", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setProvider",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "provider_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setBudget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "deliverable", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "complete",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "reason", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reject",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "reason", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },

  // ──────────────────── View ────────────────────
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "client", type: "address" },
          { name: "provider", type: "address" },
          { name: "evaluator", type: "address" },
          { name: "description", type: "string" },
          { name: "budget", type: "uint256" },
          { name: "expiredAt", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "hook", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "jobs",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "client", type: "address" },
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "description", type: "string" },
      { name: "budget", type: "uint256" },
      { name: "expiredAt", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "hook", type: "address" },
    ],
  },
  {
    type: "function",
    name: "jobCounter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "jobHasBudget",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "hasBudget", type: "bool" }],
  },
  {
    type: "function",
    name: "paymentToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "platformFeeBP",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "evaluatorFeeBP",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "platformTreasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "whitelistedHooks",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ──────────────────── Admin（spike/部署用，业务代码不调） ────────────────────
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentToken_", type: "address" },
      { name: "treasury_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPlatformFee",
    stateMutability: "nonpayable",
    inputs: [
      { name: "feeBP_", type: "uint256" },
      { name: "treasury_", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setEvaluatorFee",
    stateMutability: "nonpayable",
    inputs: [{ name: "feeBP_", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setHookWhitelist",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hook", type: "address" },
      { name: "status", type: "bool" },
    ],
    outputs: [],
  },

  // ──────────────────── Events ────────────────────
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "client", type: "address", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "evaluator", type: "address", indexed: false },
      { name: "expiredAt", type: "uint256", indexed: false },
      { name: "hook", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProviderSet",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "BudgetSet",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobFunded",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "client", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobSubmitted",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "deliverable", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobCompleted",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "evaluator", type: "address", indexed: true },
      { name: "reason", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobRejected",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "rejector", type: "address", indexed: true },
      { name: "reason", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobExpired",
    inputs: [{ name: "jobId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "PaymentReleased",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EvaluatorFeePaid",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "evaluator", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "client", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "HookWhitelistUpdated",
    inputs: [
      { name: "hook", type: "address", indexed: true },
      { name: "status", type: "bool", indexed: false },
    ],
  },

  // ──────────────────── Errors ────────────────────
  { type: "error", name: "InvalidJob", inputs: [] },
  { type: "error", name: "WrongStatus", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ExpiryTooShort", inputs: [] },
  { type: "error", name: "ZeroBudget", inputs: [] },
  { type: "error", name: "ProviderNotSet", inputs: [] },
  { type: "error", name: "FeesTooHigh", inputs: [] },
  { type: "error", name: "HookNotWhitelisted", inputs: [] },
] as const;
