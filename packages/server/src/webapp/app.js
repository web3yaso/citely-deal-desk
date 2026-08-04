/**
 * Citely Deal Desk demo UI — vanilla JS, no build step.
 *
 * The story the page tells is the ERC-8183 job lifecycle: you submit a job,
 * you get back its finished verification. The browser wallet plays the 8183
 * `client` role itself: it signs createJob / approve / fund. The backend only
 * encodes calldata (keys never leave the wallet) and performs the one step the
 * chain restricts to the provider (setBudget). Payment for the case IS the
 * funded escrow — requests carrying a job_id skip the x402 gate.
 */

"use strict";

const view = document.getElementById("view");

/** In-memory flow state (demo recording tool, not an app with persistence). */
const state = {
  cfg: null,
  account: null,
  jobId: null,
  deal: null,
  expiresAtIso: null,
  steps: [],
};

/* ---------------------------------------------------------------- helpers */

/**
 * Template-string renderer. XSS discipline: case pages render CALLER-SUPPLIED
 * content (deal fields, case ids — anyone can create a case), so every dynamic
 * `${...}` interpolation in this file MUST pass through esc(), except literals
 * and locally computed numbers. Grep check: `${` not followed by esc/stepState.
 */
function h(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function short(hex, keep = 6) {
  const s = String(hex);
  return s.length <= 2 + keep * 2 ? s : `${s.slice(0, 2 + keep)}…${s.slice(-4)}`;
}

function usdc(atomic) {
  return (Number(atomic) / 1e6).toFixed(2);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.message || (body.issues && JSON.stringify(body.issues)) || response.status;
    throw new Error(`${path} → ${detail}`);
  }
  return body;
}

async function loadConfig() {
  if (!state.cfg) {
    state.cfg = await api("/app/api/config");
    fillChainChip(state.cfg);
  }
  return state.cfg;
}

/* ------------------------------------------------------ shape gates & links */

/**
 * Hex shape gates. Anything that fails the shape returns null and is never
 * rendered as a link — this is the first XSS gate (href injection) as well as
 * the "no wrong explorer link" gate. Applies to sessionStorage reads and to
 * endpoint responses alike: both are untrusted input.
 */
function asTxHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
}

function asAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

function arcscanBase(cfg) {
  return cfg && typeof cfg.arcscan_base === "string" ? cfg.arcscan_base.replace(/\/+$/, "") : null;
}

function arcscanTxUrl(cfg, hash) {
  const base = arcscanBase(cfg);
  const tx = asTxHash(hash);
  return base && tx ? `${base}/tx/${tx}` : null;
}

function arcscanAddressUrl(cfg, address) {
  const base = arcscanBase(cfg);
  const addr = asAddress(address);
  return base && addr ? `${base}/address/${addr}` : null;
}

/** Explorer link, or plain escaped text when the shape gate refuses. */
function txLinkHtml(cfg, hash, label) {
  const url = arcscanTxUrl(cfg, hash);
  const text = label === undefined ? `tx ${short(hash, 8)}` : label;
  if (!url) return `<span class="mono">${esc(text)}</span>`;
  return `<a class="mono" href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

function addressLinkHtml(cfg, address, label) {
  const url = arcscanAddressUrl(cfg, address);
  const text = label === undefined ? short(address) : label;
  if (!url) return `<span class="mono">${esc(text)}</span>`;
  return `<a class="mono" href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

function unknownHtml() {
  return `<span class="muted small">unknown — on-chain state unavailable</span>`;
}

function fillChainChip(cfg) {
  const chip = document.getElementById("chain-chip");
  if (!chip) return;
  chip.replaceChildren(h(`<span>ERC-8183 · Arc Testnet · ${addressLinkHtml(cfg, cfg.job_contract)}</span>`));
}

/* -------------------------------------------------- 8183 lifecycle timeline */

/**
 * The four beats. Labels / events / states are copied from the design (§3.1),
 * which copies the contract doc — changing this table changes the narrative.
 */
const JOB_BEATS = [
  { id: "created",   label: "Job created",          event: "JobCreated",   state: "open" },
  { id: "funded",    label: "Escrow funded",        event: "JobFunded",    state: "funded" },
  { id: "submitted", label: "Work submitted",       event: "JobSubmitted", state: "submitted" },
  { id: "verified",  label: "Verified & completed", event: "JobCompleted", state: "completed" },
];

/** The six on-chain JobState values. Anything else is treated as unreadable. */
const JOB_STATES = ["open", "funded", "submitted", "completed", "rejected", "expired"];

/**
 * Beat status per on-chain JobState. `unknown` where the chain genuinely does
 * not say (a job can be rejected straight out of `funded`, so "was work ever
 * submitted?" is only answerable from evidence, never from the status alone).
 */
const BEATS_BY_CHAIN_STATE = {
  open:      ["done", "pending", "pending", "pending"],
  funded:    ["done", "done", "active", "pending"],
  submitted: ["done", "done", "done", "active"],
  completed: ["done", "done", "done", "done"],
  rejected:  ["done", "done", "unknown", "failed"],
  expired:   ["done", "done", "unknown", "failed"],
};

const TERMINAL_LABELS = {
  completed: "Verified & completed",
  rejected: "Rejected — escrow refunded to your wallet",
  expired: "Expired — refund claimable / claimed by the client",
  awaiting: "Awaiting evaluator",
};

const BEAT_NOTES = {
  created: "Includes BudgetSet — the one step the chain restricts to the provider, so Citely signs it.",
  funded: "approve, then fund: the USDC lands in the 8183 escrow contract, never in a Citely address.",
  submitted: "deliverable = sa_hash — hash only, the SA document stays off-chain.",
};

const VERIFIED_NOTES = {
  completed: "reason = the verification report hash — hash only, the report stays off-chain.",
  rejected: "The evaluator rejected the job on-chain; the escrow goes back to the client.",
  expired: "The job passed its expiry; the client can claim the escrow back.",
  awaiting: "Only the evaluator key can release or refund the escrow.",
};

/** "complete" / "reject" as recorded in the case snapshot → terminal beat kind. */
function terminalKindFromSnapshot(snap) {
  const settlement = snap && snap.settlement;
  if (!settlement) return null;
  if (settlement.action === "complete") return "completed";
  if (settlement.action === "reject") return "rejected";
  return null;
}

/**
 * Build the timeline model. **Evidence only — missing evidence is `unknown`,
 * never a guess.** The chain wins when it is readable; otherwise the case
 * record can only promote the beats it actually proves.
 *
 * @param {object} p
 * @param {object|null} p.chainStatus GET /app/api/jobs/:id result, null on failure
 * @param {object|null} p.snapshot    case snapshot (case view only)
 * @param {object} p.localTxs         tx hashes this browser sent in this session
 * @param {string|null} p.terminalKind "completed" | "rejected" | "expired" | null
 * @returns {{beats: Array<object>, chainKnown: boolean}}
 */
function buildTimelineModel(p) {
  const params = p || {};
  const snapshot = params.snapshot || null;
  const localTxs = params.localTxs || {};
  const raw = params.chainStatus || null;
  const chainState = raw && JOB_STATES.indexOf(raw.status) >= 0 ? raw.status : null;
  const chainKnown = chainState !== null;
  const chainTx = (raw && raw.tx) || {};

  let terminal = null;
  if (chainKnown) {
    if (chainState === "completed" || chainState === "rejected" || chainState === "expired") {
      terminal = chainState;
    }
  } else if (params.terminalKind) {
    terminal = params.terminalKind;
  }

  // What the case record alone can prove.
  const proved = [
    Boolean(snapshot && snapshot.jobId),
    Boolean(snapshot && snapshot.sa),
    Boolean(snapshot && snapshot.saHash) || Boolean(asTxHash(chainTx.submit)),
    terminal === "completed",
  ];

  const statuses = chainKnown
    ? BEATS_BY_CHAIN_STATE[chainState].slice()
    : proved.map((ok) => (ok ? "done" : "unknown"));
  if (!chainKnown && terminal === "rejected") statuses[3] = "failed";
  // Only evidence promotes the submitted beat out of `unknown`.
  if (statuses[2] === "unknown" && proved[2]) statuses[2] = "done";

  const settlementTx = snapshot && snapshot.settlement ? snapshot.settlement.txHash : null;
  const txs = [
    asTxHash(localTxs.createJob),
    asTxHash(localTxs.fund),
    asTxHash(chainTx.submit),
    asTxHash(chainTx.complete) || asTxHash(chainTx.reject) || asTxHash(settlementTx),
  ];

  const verifiedKind = terminal || (statuses[3] === "active" ? "awaiting" : null);
  const beats = JOB_BEATS.map((beat, index) => ({
    id: beat.id,
    label: index === 3 && verifiedKind ? TERMINAL_LABELS[verifiedKind] : beat.label,
    event: beat.event,
    status: statuses[index],
    txHash: txs[index],
    note: index === 3 ? (verifiedKind ? VERIFIED_NOTES[verifiedKind] : null) : BEAT_NOTES[beat.id],
  }));
  return { beats, chainKnown };
}

/** One handshake row under a beat: who signs it stays visible, always. */
function substepHtml(step, cfg) {
  const link = step.txHash ? `<span class="detail mono">${txLinkHtml(cfg, step.txHash)}</span>` : "";
  const detail = link + (step.detail ? `<span class="detail mono">${esc(step.detail)}</span>` : "");
  return `<li>
    <span class="who ${step.who === "you" ? "you" : ""}">${esc(step.who === "you" ? "your wallet" : step.who)}</span>
    <span>${esc(step.label)}${detail}</span>
    <span class="state">${stepStateHtml(step.status)}</span>
  </li>`;
}

/** Renders the four-beat timeline. Every interpolation goes through esc(). */
function timelineHtml(model, cfg) {
  return `<ol class="timeline">
    ${model.beats.map((beat, index) => `
      <li class="beat ${esc(beat.status)}">
        <span class="beat-no">${esc(String(index + 1))}</span>
        <div class="beat-body">
          <div class="beat-head">
            <b>${esc(beat.label)}</b>
            <span class="event mono">${esc(beat.event)}</span>
            <span class="beat-state">${esc(beat.status)}</span>
          </div>
          ${beat.note ? `<p class="small muted beat-note">${esc(beat.note)}</p>` : ""}
          ${beat.txHash ? `<p class="small">${txLinkHtml(cfg, beat.txHash)}</p>` : ""}
          ${(beat.substeps || []).length > 0
            ? `<ul class="steps substeps">${beat.substeps.map((s) => substepHtml(s, cfg)).join("")}</ul>`
            : ""}
        </div>
      </li>`).join("")}
  </ol>`;
}

/* ------------------------------------------------- local tx memory (session) */

const LOCAL_TX_KEYS = ["createJob", "setBudget", "approve", "fund"];

/** Remember only the hashes this browser sent itself — never any case content. */
function rememberLocalTxs(dealId, txs) {
  try {
    const clean = {};
    for (const key of LOCAL_TX_KEYS) {
      const hash = asTxHash(txs[key]);
      if (hash) clean[key] = hash;
    }
    sessionStorage.setItem(`citely:txs:${dealId}`, JSON.stringify(clean));
  } catch {
    // sessionStorage can be unavailable (private mode); the timeline just loses links.
  }
}

/** sessionStorage is USER-EDITABLE: every value re-enters through the shape gate. */
function readLocalTxs(dealId) {
  const clean = {};
  try {
    const raw = sessionStorage.getItem(`citely:txs:${dealId}`);
    if (!raw) return clean;
    const parsed = JSON.parse(raw);
    for (const key of LOCAL_TX_KEYS) {
      const hash = asTxHash(parsed && parsed[key]);
      if (hash) clean[key] = hash;
    }
  } catch {
    // Malformed JSON is just as untrusted as a malformed hash: drop it.
  }
  return clean;
}

/* ----------------------------------------------------------------- wallet */

function eth() {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask (or any EIP-1193 wallet).");
  return window.ethereum;
}

async function connect() {
  const accounts = await eth().request({ method: "eth_requestAccounts" });
  state.account = accounts[0];
  await ensureChain();
  return state.account;
}

async function ensureChain() {
  const cfg = await loadConfig();
  const wanted = "0x" + cfg.chain_id.toString(16);
  const current = await eth().request({ method: "eth_chainId" });
  if (current === wanted) return;
  try {
    await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
  } catch (error) {
    // 4902: chain unknown to the wallet — offer to add Arc Testnet.
    if (error && error.code === 4902) {
      await eth().request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: wanted,
          chainName: "Arc Testnet",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: ["https://rpc.testnet.arc.network"],
          blockExplorerUrls: [cfg.arcscan_base],
        }],
      });
    } else {
      throw error;
    }
  }
}

async function sendTx(tx) {
  return eth().request({
    method: "eth_sendTransaction",
    params: [{ from: state.account, to: tx.to, data: tx.data }],
  });
}

async function waitReceipt(txHash) {
  for (let i = 0; i < 60; i += 1) {
    const receipt = await eth().request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`transaction reverted: ${txHash}`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error(`timed out waiting for receipt: ${txHash}`);
}

/** jobId lives in topics[1] of JobCreated (indexed uint256). */
function jobIdFromReceipt(receipt, cfg) {
  const log = (receipt.logs || []).find(
    (entry) =>
      entry.address.toLowerCase() === cfg.job_contract.toLowerCase() &&
      entry.topics && entry.topics[0] === cfg.job_created_topic,
  );
  if (!log) throw new Error("JobCreated event not found in receipt");
  return BigInt(log.topics[1]).toString();
}

/**
 * Read the job back from the chain. Any failure returns null — the page must
 * render without it (that is the whole fallback path). 8s ceiling.
 */
async function fetchJobStatus(jobId) {
  if (!/^\d{1,78}$/.test(String(jobId))) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`/app/api/jobs/${encodeURIComponent(String(jobId))}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return normalizeJobStatus(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The endpoint response is untrusted input too: whitelist status, gate hashes. */
function normalizeJobStatus(body) {
  if (!body || typeof body !== "object") return null;
  if (JOB_STATES.indexOf(body.status) < 0) return null;
  const tx = body.tx && typeof body.tx === "object" ? body.tx : {};
  return {
    job_id: typeof body.job_id === "string" && /^\d{1,78}$/.test(body.job_id) ? body.job_id : null,
    status: body.status,
    client: asAddress(body.client),
    provider: asAddress(body.provider),
    evaluator: asAddress(body.evaluator),
    budget_atomic: /^\d{1,78}$/.test(String(body.budget_atomic)) ? String(body.budget_atomic) : null,
    expired_at: /^\d{1,20}$/.test(String(body.expired_at)) ? String(body.expired_at) : null,
    tx: {
      set_budget: asTxHash(tx.set_budget),
      submit: asTxHash(tx.submit),
      complete: asTxHash(tx.complete),
      reject: asTxHash(tx.reject),
    },
  };
}

/* ----------------------------------------------------------------- router */

function route() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/case/")) return renderCase(decodeURIComponent(hash.slice(7)));
  if (hash === "#/new") return renderNew();
  return renderService();
}
window.addEventListener("hashchange", route);

/* ---------------------------------------------------------- service view */

async function renderService() {
  view.replaceChildren(h(`<div class="card"><p class="muted">Loading agent card…</p></div>`));
  try {
    const card = await api("/.well-known/agent-card.json");
    const x = card["x-citely"] || {};
    const reg = (card.registrations || [])[0];
    const pricing = x.pricing || {};
    view.replaceChildren(h(`
      <div class="card">
        <h2>${esc(card.name)}</h2>
        <p class="small">${esc(card.description)}</p>
        <a class="btn" href="#/new">Submit a job — your wallet funds the escrow</a>
      </div>
      <div class="card">
        <h2>On-chain identity</h2>
        <dl class="kv">
          <dt>ERC-8004 agent</dt><dd class="mono">${reg ? esc(reg.agentId) : "not registered"}</dd>
          <dt>Registry</dt><dd class="mono">${reg ? esc(reg.agentRegistry) : "—"}</dd>
          <dt>Agent card</dt><dd><a class="mono" href="/.well-known/agent-card.json">/.well-known/agent-card.json</a></dd>
          <dt>Pricing (x402 path)</dt><dd>${esc(pricing.price_usdc || pricing.model || "—")} ${pricing.price_usdc ? "USDC per case" : ""}</dd>
        </dl>
      </div>
      <div class="card">
        <h2>What it does</h2>
        ${(x.capabilities || []).map((c) => `<h3>${esc(c.id)}</h3><p class="small muted">${esc(c.summary)}</p>`).join("")}
      </div>
      <div class="card">
        <h2>Compliance modules (bought per call from msb-agent)</h2>
        <table><tr><th>Module</th><th>Jurisdiction</th><th>Procurement</th></tr>
        ${(x.modules || []).map((m) => `<tr><td class="mono">${esc(m.id)}</td><td>${esc(m.jurisdiction)}</td><td class="muted small">${esc(m.procurement)}</td></tr>`).join("")}
        </table>
      </div>
    `));
  } catch (error) {
    view.replaceChildren(h(`<div class="card"><p class="error">${esc(error.message)}</p></div>`));
  }
}

/* --------------------------------------------------------- new case view */

/** `beat` groups each signature under the 8183 lifecycle beat it belongs to. */
const STEPS = [
  { id: "connect", beat: "created", who: "you", label: "Connect wallet (Arc Testnet)" },
  { id: "createJob", beat: "created", who: "you", label: "createJob — open an 8183 job (signature 1)" },
  { id: "setBudget", beat: "created", who: "citely", label: "setBudget — provider-only step, chain enforces it" },
  { id: "approve", beat: "funded", who: "you", label: "approve USDC to the escrow contract (signature 2)" },
  { id: "fund", beat: "funded", who: "you", label: "fund — your USDC moves into escrow, not to Citely (signature 3)" },
  { id: "case", beat: "submitted", who: "agent", label: "Run the case — adjudicate, buy evidence from msb-agent, sign SA, verify, settle" },
];

function stepStateHtml(status) {
  if (status === "running") return `<span class="spinner"></span>`;
  if (status === "done") return `<span class="badge ok">done</span>`;
  if (status === "error") return `<span class="badge fail">failed</span>`;
  return `<span class="badge neutral">waiting</span>`;
}

/**
 * Beat status for the live flow: derived from steps this page **watched
 * happen**, not from anything assumed about the chain.
 */
function flowBeatStatus(id, substeps) {
  if (id === "verified") {
    const caseStep = state.steps.find((s) => s.id === "case");
    if (!caseStep || caseStep.status === "pending") return "pending";
    if (caseStep.status === "error") return "failed";
    if (caseStep.status === "done") return "active";
    return "pending";
  }
  if (substeps.length === 0) return "pending";
  if (substeps.some((s) => s.status === "error")) return "failed";
  if (substeps.every((s) => s.status === "done")) return "done";
  if (substeps.some((s) => s.status === "running")) return "active";
  return "pending";
}

function buildFlowTimelineModel() {
  const beats = JOB_BEATS.map((beat) => {
    const substeps = state.steps.filter((s) => s.beat === beat.id);
    let note = beat.id === "verified"
      ? "The evaluator key completes or rejects the job — the verification lands on the case page."
      : BEAT_NOTES[beat.id];
    // Once the receipt is in, beat 1 can name the job it actually opened.
    if (beat.id === "created" && state.jobId) note = `Job #${state.jobId} is open. ${note}`;
    return {
      id: beat.id,
      label: beat.label,
      event: beat.event,
      status: flowBeatStatus(beat.id, substeps),
      txHash: null,
      note,
      substeps,
    };
  });
  return { beats, chainKnown: false };
}

function renderSteps() {
  const mount = document.getElementById("steps");
  if (!mount) return;
  mount.replaceChildren(h(timelineHtml(buildFlowTimelineModel(), state.cfg)));
}

function setStep(id, status, detail) {
  const step = state.steps.find((s) => s.id === id);
  if (!step) return;
  step.status = status;
  if (detail !== undefined) step.detail = detail;
  renderSteps();
}

async function renderNew() {
  const cfg = await loadConfig();
  const budget = (Number(cfg.case_budget_atomic) / 1e6).toFixed(2);
  state.steps = STEPS.map((s) => ({ ...s, status: "pending", detail: "", txHash: null }));
  const suffix = Date.now().toString(36);
  view.replaceChildren(h(`
    <div class="card">
      <h2>Submit a job to Citely — your wallet is the ERC-8183 client</h2>
      <p class="small muted">Your wallet opens the job and funds ${esc(budget)} USDC into the escrow
      contract <span class="mono">${esc(short(cfg.job_contract))}</span>. Citely can submit work
      against it, but only the evaluator key can release or refund your money.</p>
      <label>Deal ID (idempotency key)</label>
      <input id="f-deal-id" value="web-demo-${esc(suffix)}" />
      <label>Payer country → payee country</label>
      <div style="display:flex;gap:10px">
        <input id="f-payer" value="US" style="width:80px" />
        <input id="f-payee-country" value="SG" style="width:80px" />
        <input id="f-activity" value="money_transmission" disabled />
      </div>
      <label>Settlement leg — payee address / amount (USDC)</label>
      <div style="display:flex;gap:10px">
        <input id="f-payee" value="0x000000000000000000000000000000000000bEEF" />
        <input id="f-amount" value="12500.00" style="width:140px" />
      </div>
      <label>Evidence — compliance note (free text, adjudicated)</label>
      <textarea id="f-note" rows="3">Counterparty operates a licensed remittance corridor between the United States and Singapore. Onboarding pack contains incorporation documents, a FinCEN MSB registration number and two years of transaction monitoring reports.</textarea>
      <label>Evidence keys (JSON — the deterministic rules engine matches on these exact keys)</label>
      <textarea id="f-evidence" rows="10">{
  "incorporation_country": "SG",
  "fincen_msb_registration": "31000012345678",
  "bsa_aml_program": true,
  "sar_monitoring_and_filing_controls": true,
  "state_licenses": ["NY-MT-2024-0917"],
  "aml_program_last_reviewed": "2026-03-14",
  "transaction_monitoring": true
}</textarea>
      <label>Job expiry (minutes from now, chain floor is ${esc(String(Math.ceil(cfg.min_expiry_seconds / 60)))} min)</label>
      <input id="f-expiry" value="30" style="width:90px" />
      <p style="margin-top:14px">
        <button id="go">Connect & run</button>
        <button id="retry" class="secondary" style="display:none">Retry failed step</button>
      </p>
      <p id="flow-error" class="error"></p>
    </div>
    <div class="card">
      <h2>ERC-8183 job lifecycle</h2>
      <p class="small muted">Four on-chain beats. Each signature below sits under the beat it produces —
      the order is forced by the chain, not by us.</p>
      <div id="steps"></div>
    </div>
    <div class="card">
      <h2>The escrow contract</h2>
      <dl class="kv">
        <dt>8183 contract</dt><dd>${addressLinkHtml(cfg, cfg.job_contract, cfg.job_contract)}</dd>
        <dt>Chain</dt><dd class="mono">Arc Testnet · chainId ${esc(String(cfg.chain_id))}</dd>
        <dt>Escrow per case</dt><dd class="mono">${esc(budget)} USDC</dd>
        <dt>Provider (Citely)</dt><dd>${addressLinkHtml(cfg, cfg.provider)}</dd>
        <dt>Evaluator (verifier key)</dt><dd>${addressLinkHtml(cfg, cfg.evaluator)}</dd>
      </dl>
    </div>
  `));
  renderSteps();
  document.getElementById("go").addEventListener("click", () => runFlow(false));
  document.getElementById("retry").addEventListener("click", () => runFlow(true));
}

function readForm(cfg) {
  const minutes = Math.max(Number(document.getElementById("f-expiry").value) || 30,
    Math.ceil(cfg.min_expiry_seconds / 60) + 1);
  const expiresAtSec = Math.floor(Date.now() / 1000) + minutes * 60;
  state.expiresAtIso = new Date(expiresAtSec * 1000).toISOString();
  state.deal = {
    deal_id: document.getElementById("f-deal-id").value.trim(),
    parties: [
      { role: "payer", country: document.getElementById("f-payer").value.trim().toUpperCase() },
      { role: "payee", country: document.getElementById("f-payee-country").value.trim().toUpperCase() },
    ],
    activity: "money_transmission",
    amount_usdc: Number(document.getElementById("f-amount").value) || 12500,
    // The rules engine matches on evidence *keys* (e.g. us-msb wants
    // bsa_aml_program and sar_monitoring_and_filing_controls), so the pack must
    // be editable — a baked-in pack silently pins every case to one outcome.
    evidence: {
      ...readEvidenceJson(),
      compliance_note: document.getElementById("f-note").value,
    },
    monthly_volume_usdc: 480000,
    settlement: {
      party: "payee",
      payee: document.getElementById("f-payee").value.trim(),
      amount_usdc: document.getElementById("f-amount").value.trim(),
    },
    expires_at: state.expiresAtIso,
  };
  return { expiresAtSec };
}

/** Parse the evidence-keys textarea. compliance_note is merged in afterwards
 *  from its own field, so a note key here would be overwritten. */
function readEvidenceJson() {
  let parsed;
  try {
    parsed = JSON.parse(document.getElementById("f-evidence").value);
  } catch (error) {
    throw new Error(`Evidence keys are not valid JSON: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Evidence keys must be a JSON object.");
  }
  return parsed;
}

async function runFlow(isRetry) {
  const cfg = await loadConfig();
  const errorBox = document.getElementById("flow-error");
  const retryButton = document.getElementById("retry");
  errorBox.textContent = "";
  retryButton.style.display = "none";
  document.getElementById("go").disabled = true;

  // Fresh run re-reads the form; a retry must keep the same deal (idempotency).
  // Form errors (e.g. evidence JSON that does not parse) must land in the error
  // box, not escape as an unhandled rejection with the button stuck disabled.
  let expiresAtSec;
  try {
    if (!isRetry || !state.deal) ({ expiresAtSec } = readForm(cfg));
    else expiresAtSec = Math.floor(new Date(state.expiresAtIso).getTime() / 1000);
  } catch (error) {
    errorBox.textContent = error.message;
    document.getElementById("go").disabled = false;
    return;
  }

  const run = async (id, fn) => {
    const step = state.steps.find((s) => s.id === id);
    if (step.status === "done") return;
    setStep(id, "running");
    try {
      await fn(step);
      setStep(id, "done");
    } catch (error) {
      setStep(id, "error", error.message);
      throw error;
    }
  };

  try {
    await run("connect", async (step) => {
      const account = await connect();
      step.detail = account;
    });

    await run("createJob", async (step) => {
      const tx = await api("/app/api/encode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "createJob", params: { expired_at: String(expiresAtSec) } }),
      });
      const txHash = await sendTx(tx);
      step.txHash = txHash;
      renderSteps();
      const receipt = await waitReceipt(txHash);
      state.jobId = jobIdFromReceipt(receipt, cfg);
      step.detail = `job #${state.jobId}`;
    });

    await run("setBudget", async (step) => {
      const result = await api(`/app/api/jobs/${state.jobId}/set-budget`, { method: "POST" });
      step.txHash = result.tx_hash;
    });

    await run("approve", async (step) => {
      const tx = await api("/app/api/encode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", params: {} }),
      });
      const txHash = await sendTx(tx);
      step.txHash = txHash;
      await waitReceipt(txHash);
    });

    await run("fund", async (step) => {
      const tx = await api("/app/api/encode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fund", params: { job_id: state.jobId } }),
      });
      const txHash = await sendTx(tx);
      step.txHash = txHash;
      step.detail = `${(Number(cfg.case_budget_atomic) / 1e6).toFixed(2)} USDC now in escrow`;
      await waitReceipt(txHash);
    });

    await run("case", async (step) => {
      step.detail = "adjudicating · buying evidence from msb-agent over x402 · signing SA · verifying — takes a minute or two on a live chain";
      renderSteps();
      const body = { ...state.deal, job_id: state.jobId };
      await api("/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      step.detail = "settled";
    });

    // Hand the hashes this browser sent to the case page — the server never
    // sees createJob / approve / fund, they are the wallet's own transactions.
    rememberLocalTxs(state.deal.deal_id, {
      createJob: stepTxHash("createJob"),
      setBudget: stepTxHash("setBudget"),
      approve: stepTxHash("approve"),
      fund: stepTxHash("fund"),
    });
    location.hash = `#/case/${encodeURIComponent(state.deal.deal_id)}`;
  } catch (error) {
    errorBox.textContent = error.message;
    retryButton.style.display = "inline-block";
  } finally {
    document.getElementById("go").disabled = false;
  }
}

function stepTxHash(id) {
  const step = state.steps.find((s) => s.id === id);
  return step ? step.txHash : null;
}

/* -------------------------------------------------------- case detail view */

function legsBanner(legs) {
  const payable = legs.filter((leg) => leg.condition === "PASS" && (leg.basis || []).length > 0);
  if (payable.length === 0) {
    const holds = legs.filter((l) => l.condition !== "PASS").length;
    return `<div class="banner hold">
      <h2>Your wallet's decision: execute = false — it pays nothing</h2>
      <p class="small">${holds} settlement leg(s) failed the wallet's preset policy: it only pays a
      leg whose SA condition is PASS with a cited basis, and this SA carries HOLD/ESCALATE instead.
      <b>The SA is proof, not an instruction</b> — nothing moves.</p>
    </div>`;
  }
  const cleared = payable
    .map((leg) => `${(Number(leg.amount_nominal) / 1e6).toFixed(2)} USDC to ${short(leg.payee, 8)}`)
    .join(", ");
  return `<div class="banner pass">
    <h2>Your wallet's decision: execute = true — pay ${esc(cleared)}</h2>
    <p class="small">The SA proves condition=PASS with a cited basis for
    ${payable.length === legs.length ? "every settlement leg" : `${payable.length} of ${legs.length} settlement legs`},
    so the wallet's own preset policy clears the payment — to the payee named in the SA,
    never a Citely address. <b>The SA is proof, not an instruction</b>: this decision is the wallet's.</p>
  </div>`;
}

/**
 * The bought module's per-check results — the *source* of the per-leg
 * condition. A HOLD badge without this table cannot answer "held on what?";
 * each row names the check, its result, and the missing-evidence reason.
 */
function moduleChecksCards(results) {
  if (!results || results.length === 0) return "";
  return results.map((m) => `<div class="card">
    <h2>Compliance module checks — ${esc(m.module)}@${esc(m.version)}</h2>
    <table><tr><th>Check</th><th>Result</th><th>Basis</th><th>Reason</th></tr>
    ${m.checks.map((c) => `<tr>
      <td class="mono small">${esc(c.id)}</td>
      <td><span class="badge ${esc(c.result)}">${esc(c.result)}</span></td>
      <td class="mono small muted">${esc(c.basis)}</td>
      <td class="small">${esc(c.reason)}<br><span class="muted small">${esc(c.source)}</span></td>
    </tr>`).join("")}
    </table>
    <p class="muted small">Overall ${esc(m.overall)}. The per-leg condition above derives only from
    these deterministic results — model verdicts cannot touch it. NOT_APPLICABLE means the rule did
    not trigger for this deal; it is neutral, not a pass. Check statuses compiled from public legal
    sources — not legal advice.</p>
  </div>`).join("");
}

/**
 * The delivered artefact, first thing on the page: the verification of this
 * job. Not a legal conclusion, and only hashes ever went on-chain.
 */
function verificationHeroHtml(snap, cfg) {
  const verification = snap.verification || {};
  const outcomes = verification.outcomes || [];
  const passedCount = outcomes.filter((o) => o.passed).length;
  const settlement = snap.settlement || null;
  const action = settlement ? settlement.action : null;
  const failed = verification.passed === false || action === "reject";
  const headline = failed
    ? "Verification failed — the evaluator rejected the job on-chain; escrow refunded to the client."
    : (action === "complete"
      ? `${passedCount}/${outcomes.length} deterministic checks passed — the evaluator completed this job on-chain.`
      : `${passedCount}/${outcomes.length} deterministic checks passed — the job is not closed on-chain yet.`);
  const txRow = settlement && asTxHash(settlement.txHash)
    ? `<dt>${esc(action === "reject" ? "reject tx" : "complete tx")}</dt>
       <dd>${txLinkHtml(cfg, settlement.txHash, short(settlement.txHash, 10))}</dd>`
    : `<dt>Settlement tx</dt><dd class="muted small">not closed on-chain yet</dd>`;
  return `<div class="hero ${failed ? "fail" : "pass"}">
    <h2>Verification — job #${esc(snap.jobId)}</h2>
    <p class="hero-line">${esc(headline)}</p>
    <dl class="kv">
      <dt>reason hash</dt>
      <dd>${esc(short(verification.reasonHash, 10))}
        <span class="muted small">— the second argument of the on-chain complete(jobId, reason)</span></dd>
      <dt>deliverable (sa_hash)</dt>
      <dd>${esc(short(snap.saHash, 10))}
        <span class="muted small">— what submit(jobId, deliverable) put on-chain</span></dd>
      <dt>verifier key</dt><dd>${addressLinkHtml(cfg, cfg.evaluator)}</dd>
      ${txRow}
    </dl>
    <p class="small muted">Three deterministic checks on the deliverable — not a legal conclusion.
    Hashes only; the SA document itself stays off-chain.</p>
  </div>`;
}

/** Lifecycle card body: timeline + the job facts read back from the chain. */
function jobLifecycleHtml(chainStatus, snap, cfg, localTxs) {
  const model = buildTimelineModel({
    chainStatus,
    snapshot: snap,
    localTxs,
    terminalKind: terminalKindFromSnapshot(snap),
  });
  const jobId = snap ? snap.jobId : (chainStatus ? chainStatus.job_id : null);
  const facts = `<dl class="kv">
    <dt>8183 contract</dt><dd>${addressLinkHtml(cfg, cfg.job_contract, cfg.job_contract)}</dd>
    <dt>Job</dt><dd class="mono">${jobId ? esc(`#${jobId}`) : esc("unknown")}</dd>
    <dt>Client (your wallet)</dt>
    <dd>${chainStatus && chainStatus.client ? addressLinkHtml(cfg, chainStatus.client) : unknownHtml()}</dd>
    <dt>Provider (Citely)</dt><dd>${addressLinkHtml(cfg, (chainStatus && chainStatus.provider) || cfg.provider)}</dd>
    <dt>Evaluator (verifier key)</dt><dd>${addressLinkHtml(cfg, (chainStatus && chainStatus.evaluator) || cfg.evaluator)}</dd>
    <dt>Escrow</dt>
    <dd>${chainStatus && chainStatus.budget_atomic ? `<span class="mono">${esc(usdc(chainStatus.budget_atomic))} USDC</span>` : unknownHtml()}</dd>
    <dt>setBudget tx</dt>
    <dd>${chainStatus && chainStatus.tx.set_budget ? txLinkHtml(cfg, chainStatus.tx.set_budget) : unknownHtml()}
      <span class="muted small">— provider-only, the chain restricts that step to Citely</span></dd>
  </dl>`;
  return timelineHtml(model, cfg) + facts;
}

const TIMELINE_SOURCE = {
  reading: "Reading on-chain state…",
  chain: "read from chain",
  offline: "on-chain state unavailable — shown from the case record",
};

async function renderCase(caseId) {
  view.replaceChildren(h(`<div class="card"><p class="muted">Loading case ${esc(caseId)}…</p></div>`));
  const cfg = await loadConfig();
  let record;
  try {
    record = await api(`/cases/${encodeURIComponent(caseId)}`);
  } catch (error) {
    view.replaceChildren(h(`<div class="card"><p class="error">${esc(error.message)}</p></div>`));
    return;
  }
  const localTxs = readLocalTxs(caseId);
  const snap = record.snapshot;

  // No snapshot yet: the run has not completed. The lifecycle card still
  // renders — the job may well exist on-chain already.
  if (!snap) {
    view.replaceChildren(h(`
      <div class="card"><h2>Case ${esc(caseId)}</h2>
      <p>State: <span class="badge neutral">${esc(record.state)}</span></p>
      <p class="muted small">No snapshot yet — the run has not completed.</p></div>
      <div class="card">
        <h2>ERC-8183 job lifecycle</h2>
        <p class="small muted" id="timeline-source">${esc(TIMELINE_SOURCE.reading)}</p>
        <div id="job-timeline"></div>
      </div>`));
    paintLifecycle(null, null, cfg, localTxs);
    if (record.job_id) void refreshLifecycle(record.job_id, null, cfg, localTxs);
    return;
  }

  const sa = snap.sa;
  const tx = (snap.settlement || {}).txHash;
  view.replaceChildren(h(`
    ${verificationHeroHtml(snap, cfg)}

    <div class="card">
      <h2>ERC-8183 job lifecycle</h2>
      <p class="small muted" id="timeline-source">${esc(TIMELINE_SOURCE.reading)}</p>
      <div id="job-timeline"></div>
    </div>

    <div class="card">
      <h2>Settlement Authorization — per-leg conditions</h2>
      <table><tr><th>Party</th><th>Payee</th><th>Amount</th><th>Condition</th><th>Basis</th></tr>
      ${sa.legs.map((leg) => `<tr>
        <td class="mono">${esc(leg.party)}</td>
        <td class="mono">${esc(short(leg.payee))}</td>
        <td>${esc(leg.amount_nominal)}</td>
        <td><span class="badge ${esc(leg.condition)}">${esc(leg.condition)}</span></td>
        <td class="small muted">${(leg.basis || []).map((b) => `${esc(b.item_id)} · ${esc(b.verdict)} · ${esc(b.source)}`).join("<br>")}</td>
      </tr>`).join("")}
      </table>
    </div>

    ${legsBanner(sa.legs)}

    ${moduleChecksCards(record.module_results)}

    <div class="card">
      <h2>Independent verification (three checks, separate key)</h2>
      <table><tr><th>Check</th><th>Result</th></tr>
      ${(snap.verification.outcomes || []).map((o) => `<tr><td class="mono">${esc(o.check)}</td>
        <td><span class="badge ${o.passed ? "ok" : "fail"}">${o.passed ? "pass" : "fail"}</span></td></tr>`).join("")}
      </table>
      <p class="muted small">Signature check verifies the operator-signed SA against the verifier's
      registry — never self-attested. Shown from the verifier report; this page does not re-derive it.</p>
    </div>

    <div class="card">
      <h2>Agent bought evidence from another agent</h2>
      ${snap.procurement ? `
      <dl class="kv">
        <dt>Supplier</dt><dd>msb-agent (ERC-8004 · 851930) — separate repo, wallet, pricing</dd>
        <dt>Paid</dt><dd>${esc((Number(snap.procurement.paidAtomic) / 1e6).toFixed(2))} USDC over x402 / Circle Gateway</dd>
        <dt>Gateway receipt</dt><dd class="mono">${esc(snap.procurement.settlementId)}</dd>
        <dt>Replayed</dt><dd>${snap.procurement.reused
          ? "yes — a paid attempt of this case failed mid-run; the retry reused the evidence on file, nothing was paid twice"
          : "no — this case bought its own evidence (every new case pays per call; only a failed-then-retried case reuses)"}</dd>
      </dl>
      <p class="muted small">Gateway batched settlement: the payment moves inside the GatewayWallet
      contract's ledger, so there is no per-call on-chain tx to link. Audit trail: the payer's
      Gateway balance decrements by exactly this amount, and both agents record the same receipt id.</p>` : `<p class="muted small">No procurement this run (evidence already on file).</p>`}
    </div>

    <div class="card">
      <h2>Model verdicts (cannot move money)</h2>
      <p class="muted small">Release conditions derive only from the compliance module's results —
      the policy engine's type signature cannot even receive these verdicts.</p>
      <table><tr><th>Item</th><th>Verdict</th><th>Confidence</th></tr>
      ${(snap.adjudication || []).map((a) => `<tr><td class="mono">${esc(a.item_id)}</td><td>${esc(a.verdict)}</td><td class="muted">${esc(a.confidence)}</td></tr>`).join("")}
      </table>
    </div>

    <div class="card">
      <h2>Case record</h2>
      <dl class="kv">
        <dt>Case id</dt><dd class="mono">${esc(caseId)}</dd>
        <dt>State / exit</dt><dd><span class="badge neutral">${esc(record.state)}</span>
          <span class="muted small">${esc(snap.routing.exit)} — ${esc(snap.routing.reason)}</span></dd>
        <dt>Valid until</dt><dd class="mono">${esc(sa.bound_to.expires_at)}</dd>
        ${tx ? `<dt>Settlement tx</dt><dd>${txLinkHtml(cfg, tx, short(tx, 10))}</dd>` : ""}
      </dl>
    </div>
  `));
  paintLifecycle(null, snap, cfg, localTxs);
  void refreshLifecycle(snap.jobId, snap, cfg, localTxs);
}

/** Repaints the lifecycle card in place; a no-op once the user navigated away. */
function paintLifecycle(chainStatus, snap, cfg, localTxs) {
  const mount = document.getElementById("job-timeline");
  if (!mount) return;
  mount.replaceChildren(h(jobLifecycleHtml(chainStatus, snap, cfg, localTxs)));
}

async function refreshLifecycle(jobId, snap, cfg, localTxs) {
  const chainStatus = await fetchJobStatus(jobId);
  const source = document.getElementById("timeline-source");
  if (source) {
    source.textContent = chainStatus ? TIMELINE_SOURCE.chain : TIMELINE_SOURCE.offline;
  }
  paintLifecycle(chainStatus, snap, cfg, localTxs);
}

/* ------------------------------------------------------------------ boot */
loadConfig().catch(() => {
  // The chain chip is decoration; a config failure must not stop routing.
});
route();
