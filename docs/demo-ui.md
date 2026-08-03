# Demo UI — submit a job, get back its finished verification

A three-view web app served by the agent itself at **`/app`**. Its story is the
**ERC-8183 job lifecycle**: you submit a job to Citely with your own wallet, and you get
back that job's completed verification. The core promise stays physical — **your wallet
opens the escrow job and funds it; Citely can submit work against that job but can never
move your money.**

Live: **https://citely-deal-desk-production.up.railway.app/app**

No build step, no separate deployment — three static files served by the same hono
process, backed by four small API endpoints (`/app/api/*`). None of this appears in
the agent card: it is demo tooling, not a promised capability.

Naming: at the 8183 layer it is a **job**; in the compliance record it is a **case**.
One job maps to one case, and the UI says so. Routes (`#/new`, `#/case/<deal_id>`) are
unchanged, so old links keep working.

---

## The three views

| Route | What it shows |
|---|---|
| `#/` | Service page — rendered live from the agent card: identity, capabilities, pricing, module sourcing |
| `#/new` | Submit a job — connect a wallet, fill the deal, watch the four 8183 beats light up |
| `#/case/<deal_id>` | **Verification first**: the delivered verification of that job, then the 8183 lifecycle, the SA legs, your wallet's decision, the three checks, procurement, model verdicts, and the case record |

The detail view is **read-only and needs no wallet** — you can open any existing case
directly, e.g. `#/case/rehearsal-msb1uis5`.

The header carries an ERC-8183 chip on every view: contract address, chain, and a link
into arcscan.

---

## The four beats (UI ↔ chain)

Both views render the same four-beat timeline. Each beat is a real on-chain event, and
each beat's transactions link into arcscan.

| # | UI | On-chain event | JobState after | Who signs |
|---|---|---|---|---|
| 1 | **Job created** | `JobCreated(jobId, client, provider, evaluator, expiredAt, hook)` | `open` | your wallet — includes `BudgetSet`, which the chain restricts to the provider, so Citely signs that one |
| 2 | **Escrow funded** | `JobFunded(jobId, client, amount)` | `funded` | your wallet (`approve`, then `fund`) |
| 3 | **Work submitted** | `JobSubmitted(jobId, provider, deliverable)` | `submitted` | Citely; `deliverable` = `sa_hash` (hash only, the SA document stays off-chain) |
| 4 | **Verified & completed** | `JobCompleted(jobId, evaluator, reason)` | `completed` | the evaluator key; `reason` = the verification report hash |

The terminal beat is rendered as it actually is, never optimistically:

| Outcome | JobState | UI |
|---|---|---|
| Rejected | `rejected` | **Rejected — escrow refunded to your wallet** |
| Expired | `expired` | **Expired — refund claimable / claimed by the client** |
| Submitted, not closed | `submitted` | **Awaiting evaluator** |

**The timeline never guesses.** When the chain cannot be read, beats that the case
record proves are shown as done and the rest are `unknown`, with the card labelled
`on-chain state unavailable — shown from the case record`.

---

## What you need to submit a job

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

## The signatures under each beat

The step list on `#/new` sits **underneath** the beat each signature produces, and each
row still names who signs it. The order is forced by the chain: `setBudget` is
**provider-only** on the deployed 8183 contract, so the handshake must alternate between
your wallet and ours.

| # | Who | Step | Beat |
|---|---|---|---|
| 1 | your wallet | Connect (Arc Testnet) | 1 |
| 2 | your wallet | `createJob` — signature 1; jobId is read from the `JobCreated` event in your own receipt | 1 |
| 3 | Citely | `setBudget` — the one step the chain restricts to the provider | 1 |
| 4 | your wallet | `approve` USDC to the escrow contract — signature 2 | 2 |
| 5 | your wallet | `fund` — signature 3; your USDC moves into the escrow contract, not to Citely | 2 |
| 6 | agent | `POST /cases` with your `job_id` — adjudicate, buy evidence from msb-agent over x402, sign the SA, verify, settle | 3 → 4 |

Step 6 is synchronous and takes **one to two minutes** on a live chain (chain
transactions + paid procurement + adjudication). The page shows staged hints; leave it
alone. If any step fails, the **Retry failed step** button resumes from that step —
every server-side action is idempotent (`tx_log` for chain writes, request-level
idempotency for the case), so retries never double-spend.

**The funded escrow IS the payment.** Requests carrying a `job_id` skip the x402 gate
— one adjudication is paid for once. Requests without a `job_id` hit the x402 gate
exactly as before.

---

## Demo endpoints

All four are demo-only and stay out of the agent card. The global rate limiter covers
them like every other route.

| Endpoint | Purpose |
|---|---|
| `GET /app/api/config` | Public constants: chain id, 8183 contract, USDC, provider/evaluator, case budget, `JobCreated` topic, arcscan base |
| `POST /app/api/encode` | Pre-encoded calldata for `createJob` / `approve` / `fund` — roles and amounts pinned server-side |
| `POST /app/api/jobs/:id/set-budget` | The provider-only step, signed by us after four checks (exists / provider is us / status `open` / id shape) |
| `GET /app/api/jobs/:id` | **Read-only job view** — see below |

### `GET /app/api/jobs/:id`

Reads the job back **from the chain** so the timeline shows on-chain truth rather than
what we happen to remember, plus the transactions this deployment sent itself (read from
`tx_log`; a key is simply absent when we never sent that transaction).

```jsonc
{
  "job_id": "162523",
  "status": "completed",          // open|funded|submitted|completed|rejected|expired
  "client": "0x…",
  "provider": "0x…",
  "evaluator": "0x…",
  "budget_atomic": "3000000",
  "expired_at": "1785000000",
  "tx": { "set_budget": "0x…", "submit": "0x…", "complete": "0x…" }
}
```

| Status | Meaning |
|---|---|
| `400 invalid_job_id` | Id is not a decimal string — rejected before any BigInt or RPC call |
| `404 job_not_found` | The chain returns a zero-value struct for that id |
| `502 chain_unavailable` | Chain read failed. The message is a fixed safe string; the underlying RPC error goes to the server log only (it can contain URLs or keys) |

Everything it returns is already public (on-chain state, or values already exposed by
`/app/api/config`). Successful reads are cached in memory for 10 seconds so that an
unauthenticated GET can never become an RPC amplifier — both public Arc RPCs rate-limit.
The page tolerates every failure mode: if this endpoint is slow (8s ceiling), down, or
returns anything unexpected, the case page still renders from the case record and says
so.

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
