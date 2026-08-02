# Demo UI — your wallet as the ERC-8183 client

A three-view web app served by the agent itself at **`/app`**. Its point is to make the
core promise physical: **your wallet opens the escrow job and funds it; Citely can
submit work against that job but can never move your money.**

Live: **https://citely-deal-desk-production.up.railway.app/app**

No build step, no separate deployment — three static files served by the same hono
process, backed by three small API endpoints (`/app/api/*`). None of this appears in
the agent card: it is demo tooling, not a promised capability.

---

## The three views

| Route | What it shows |
|---|---|
| `#/` | Service page — rendered live from the agent card: identity, capabilities, pricing, module sourcing |
| `#/new` | Start a case — connect a wallet, fill the deal, run the six-step handshake |
| `#/case/<deal_id>` | Case detail — exit routing, model verdicts, agent-to-agent procurement, SA legs, verification, and the closing wallet-decision banner |

The detail view is **read-only and needs no wallet** — you can open any existing case
directly, e.g. `#/case/rehearsal-msb1uis5`.

---

## What you need to start a case

1. **A browser wallet** (MetaMask or any EIP-1193 wallet). The page offers to add /
   switch to Arc Testnet (chainId `5042002`) automatically.
2. **Testnet USDC in that wallet** — the case budget (3.00 USDC by default) plus gas.
   Gas on Arc is denominated in USDC, so one asset covers both.
   Faucet: https://faucet.circle.com
3. Nothing else. No API key, no account. Your keys never leave the wallet — the
   backend only returns pre-encoded calldata (`/app/api/encode`), and the encoding
   pins `provider`, `evaluator` and the amount server-side, so a tampered request
   cannot produce a job with the wrong roles.

---

## The six-step handshake

The step list on `#/new` shows who performs each step. The order is forced by the
chain: `setBudget` is **provider-only** on the deployed 8183 contract, so the
handshake must alternate between your wallet and ours.

| # | Who | Step |
|---|---|---|
| 1 | your wallet | Connect (Arc Testnet) |
| 2 | your wallet | `createJob` — signature 1; jobId is read from the `JobCreated` event in your own receipt |
| 3 | Citely | `setBudget` — the one step the chain restricts to the provider |
| 4 | your wallet | `approve` USDC to the escrow contract — signature 2 |
| 5 | your wallet | `fund` — signature 3; your USDC moves into the escrow contract, not to Citely |
| 6 | agent | `POST /cases` with your `job_id` — adjudicate, buy evidence from msb-agent over x402, sign the SA, verify, settle |

Step 6 is synchronous and takes **one to two minutes** on a live chain (chain
transactions + paid procurement + adjudication). The page shows staged hints; leave it
alone. If any step fails, the **Retry failed step** button resumes from that step —
every server-side action is idempotent (`tx_log` for chain writes, request-level
idempotency for the case), so retries never double-spend.

**The funded escrow IS the payment.** Requests carrying a `job_id` skip the x402 gate
— one adjudication is paid for once. Requests without a `job_id` hit the x402 gate
exactly as before.

---

## Running locally

The repo-root `.env` must exist (wallet keys + OpenAI key; see `.env.example`). Then:

```bash
PORT=8899 \
PUBLIC_BASE_URL=http://localhost:8899 \
X402_SELL_MODE=off \
ARC_RPC_URL=https://arc-testnet.drpc.org \
ARC_RPC_URL_FALLBACK=https://rpc.testnet.arc.network \
VERIFIER_MODE=in-process \
VERIFIER_ADDRESS=<address derived from your VERIFIER_PRIVATE_KEY> \
CASE_BUDGET_USDC=3.00 \
MODULE_PRICE_USDC=0.80 \
RUBRIC_PATH=rubrics/us-msb.json \
pnpm --filter @citely/server start
```

Open http://localhost:8899/app.

Three pitfalls, all hit during real-chain rehearsal:

- **`VERIFIER_ADDRESS` must match `VERIFIER_PRIVATE_KEY`.** A mismatch stays green
  through the whole flow and only reverts (`Unauthorized`) at the final `complete` —
  the job's evaluator was set to an address whose key the verifier does not hold.
- **Pin the RPC.** Both public Arc RPCs rate-limit, in both directions. The command
  above pins drpc with the public endpoint as fallback.
- **Procurement needs Circle Gateway balance**, not wallet balance — each case buys
  evidence for 0.80 USDC from that balance. Top up ahead of time
  (`node --import tsx scripts/gateway-deposit.ts 1.50`; deposits take minutes).

### Headless rehearsal (no browser)

`scripts/spike/external-job-case.ts` walks the exact HTTP sequence the UI uses —
encode → sign with the marketplace key → set-budget → fund → `POST /cases` — against
a running server. Use it to verify the pipeline before touching a browser:

```bash
ARC_RPC_URL=https://arc-testnet.drpc.org \
node --import tsx scripts/spike/external-job-case.ts [--base http://localhost:8899]
```

---

## Known limitation

The server does not verify that the request sender **is** the job's on-chain client —
anyone who knows a funded jobId could bind their own deal to it. Fixing this requires
request signing; out of scope for a testnet demo, and stated in the code where the
check would go.
