/**
 * Citely Deal Desk demo UI — vanilla JS, no build step.
 *
 * The browser wallet plays the ERC-8183 `client` role itself: it signs
 * createJob / approve / fund. The backend only encodes calldata (keys never
 * leave the wallet) and performs the one step the chain restricts to the
 * provider (setBudget). Payment for the case IS the funded escrow — requests
 * carrying a job_id skip the x402 gate.
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
  if (!state.cfg) state.cfg = await api("/app/api/config");
  return state.cfg;
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
        <a class="btn" href="#/new">Start a case — your wallet funds the escrow</a>
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

const STEPS = [
  { id: "connect", who: "you", label: "Connect wallet (Arc Testnet)" },
  { id: "createJob", who: "you", label: "createJob — open an 8183 job (signature 1)" },
  { id: "setBudget", who: "citely", label: "setBudget — provider-only step, chain enforces it" },
  { id: "approve", who: "you", label: "approve USDC to the escrow contract (signature 2)" },
  { id: "fund", who: "you", label: "fund — your USDC moves into escrow, not to Citely (signature 3)" },
  { id: "case", who: "agent", label: "Run the case — adjudicate, buy evidence from msb-agent, sign SA, verify, settle" },
];

function stepStateHtml(status) {
  if (status === "running") return `<span class="spinner"></span>`;
  if (status === "done") return `<span class="badge ok">done</span>`;
  if (status === "error") return `<span class="badge fail">failed</span>`;
  return `<span class="badge neutral">waiting</span>`;
}

function renderSteps() {
  const list = document.getElementById("steps");
  if (!list) return;
  list.replaceChildren(h(state.steps.map((step) => `
    <li>
      <span class="who ${step.who === "you" ? "you" : ""}">${step.who === "you" ? "your wallet" : step.who}</span>
      <span>${esc(step.label)}${step.detail ? `<span class="detail mono">${esc(step.detail)}</span>` : ""}</span>
      <span class="state">${stepStateHtml(step.status)}</span>
    </li>`).join("")));
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
  state.steps = STEPS.map((s) => ({ ...s, status: "pending", detail: "" }));
  const suffix = Date.now().toString(36);
  view.replaceChildren(h(`
    <div class="card">
      <h2>Start a case</h2>
      <p class="small muted">Your wallet becomes the 8183 <b>client</b>: it opens the job and funds
      ${esc(budget)} USDC into the escrow contract <span class="mono">${esc(short(cfg.job_contract))}</span>.
      Citely can submit work against that job but can never move your money — only the evaluator
      verdict releases or refunds it.</p>
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
      <label>Job expiry (minutes from now, chain floor is ${esc(String(Math.ceil(cfg.min_expiry_seconds / 60)))} min)</label>
      <input id="f-expiry" value="30" style="width:90px" />
      <p style="margin-top:14px">
        <button id="go">Connect & run</button>
        <button id="retry" class="secondary" style="display:none">Retry failed step</button>
      </p>
      <p id="flow-error" class="error"></p>
    </div>
    <div class="card"><h2>Handshake</h2><ul class="steps" id="steps"></ul></div>
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
    // Full evidence pack matching the demo fixture: drop a signal and the
    // adjudication slides to gray → exit 4, which this HTTP path does not wire.
    evidence: {
      incorporation_country: "SG",
      fincen_msb_registration: "31000012345678",
      state_licenses: ["NY-MT-2024-0917"],
      aml_program_last_reviewed: "2026-03-14",
      transaction_monitoring: true,
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

async function runFlow(isRetry) {
  const cfg = await loadConfig();
  const errorBox = document.getElementById("flow-error");
  const retryButton = document.getElementById("retry");
  errorBox.textContent = "";
  retryButton.style.display = "none";
  document.getElementById("go").disabled = true;

  // Fresh run re-reads the form; a retry must keep the same deal (idempotency).
  let expiresAtSec;
  if (!isRetry || !state.deal) ({ expiresAtSec } = readForm(cfg));
  else expiresAtSec = Math.floor(new Date(state.expiresAtIso).getTime() / 1000);

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
      step.detail = `tx ${short(txHash)}`;
      renderSteps();
      const receipt = await waitReceipt(txHash);
      state.jobId = jobIdFromReceipt(receipt, cfg);
      step.detail = `job ${state.jobId} · tx ${short(txHash)}`;
    });

    await run("setBudget", async (step) => {
      const result = await api(`/app/api/jobs/${state.jobId}/set-budget`, { method: "POST" });
      step.detail = `tx ${short(result.tx_hash)}`;
    });

    await run("approve", async (step) => {
      const tx = await api("/app/api/encode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", params: {} }),
      });
      const txHash = await sendTx(tx);
      step.detail = `tx ${short(txHash)}`;
      await waitReceipt(txHash);
    });

    await run("fund", async (step) => {
      const tx = await api("/app/api/encode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fund", params: { job_id: state.jobId } }),
      });
      const txHash = await sendTx(tx);
      step.detail = `tx ${short(txHash)} — ${(Number(cfg.case_budget_atomic) / 1e6).toFixed(2)} USDC now in escrow`;
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

    location.hash = `#/case/${encodeURIComponent(state.deal.deal_id)}`;
  } catch (error) {
    errorBox.textContent = error.message;
    retryButton.style.display = "inline-block";
  } finally {
    document.getElementById("go").disabled = false;
  }
}

/* -------------------------------------------------------- case detail view */

function legsBanner(legs) {
  const payable = legs.filter((leg) => leg.condition === "PASS" && (leg.basis || []).length > 0);
  if (payable.length === 0) {
    const holds = legs.filter((l) => l.condition !== "PASS").length;
    return `<div class="banner hold">
      <h2>Your wallet's decision: execute = false</h2>
      <p class="small">${holds} leg(s) not payable under this wallet's policy (only PASS legs with a
      cited basis are ever paid). <b>The SA is proof, not an instruction</b> — nothing moves.</p>
    </div>`;
  }
  return `<div class="banner pass">
    <h2>Your wallet's decision: ${payable.length} leg(s) payable</h2>
    <p class="small">Payment targets are always the payees named in the SA — never a Citely address.</p>
  </div>`;
}

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
  const snap = record.snapshot;
  if (!snap) {
    view.replaceChildren(h(`
      <div class="card"><h2>Case ${esc(caseId)}</h2>
      <p>State: <span class="badge neutral">${esc(record.state)}</span></p>
      <p class="muted small">No snapshot yet — the run has not completed.</p></div>`));
    return;
  }
  const sa = snap.sa;
  const tx = (snap.settlement || {}).txHash;
  view.replaceChildren(h(`
    <div class="card">
      <h2>Case ${esc(caseId)}</h2>
      <dl class="kv">
        <dt>State / exit</dt><dd><span class="badge neutral">${esc(record.state)}</span>
          <span class="muted small">${esc(snap.routing.exit)} — ${esc(snap.routing.reason)}</span></dd>
        <dt>8183 job</dt><dd class="mono">${esc(snap.jobId)}</dd>
        <dt>SA hash (anchored on-chain)</dt><dd class="mono">${esc(short(snap.saHash, 10))}</dd>
        <dt>Valid until</dt><dd class="mono">${esc(sa.bound_to.expires_at)}</dd>
        ${tx ? `<dt>Settlement tx</dt><dd><a class="mono" href="${esc(cfg.arcscan_base)}/tx/${esc(tx)}">${esc(short(tx, 10))}</a></dd>` : ""}
      </dl>
    </div>

    <div class="card">
      <h2>Agent bought evidence from another agent</h2>
      ${snap.procurement ? `
      <dl class="kv">
        <dt>Supplier</dt><dd>msb-agent (ERC-8004 · 851930) — separate repo, wallet, pricing</dd>
        <dt>Paid</dt><dd>${esc((Number(snap.procurement.paidAtomic) / 1e6).toFixed(2))} USDC over x402 / Circle Gateway</dd>
        <dt>Settlement id</dt><dd class="mono">${esc(snap.procurement.settlementId)}</dd>
        <dt>Replayed</dt><dd>${snap.procurement.reused ? "yes — idempotency hit, not paid twice" : "no — paid fresh this run"}</dd>
      </dl>` : `<p class="muted small">No procurement this run (evidence already on file).</p>`}
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

    <div class="card">
      <h2>Independent verification (three checks, separate key)</h2>
      <table><tr><th>Check</th><th>Result</th></tr>
      ${(snap.verification.outcomes || []).map((o) => `<tr><td class="mono">${esc(o.check)}</td>
        <td><span class="badge ${o.passed ? "ok" : "fail"}">${o.passed ? "pass" : "fail"}</span></td></tr>`).join("")}
      </table>
      <p class="muted small">Signature check verifies the operator-signed SA against the verifier's
      registry — never self-attested. Shown from the verifier report; this page does not re-derive it.</p>
    </div>

    ${legsBanner(sa.legs)}
  `));
}

/* ------------------------------------------------------------------ boot */
route();
