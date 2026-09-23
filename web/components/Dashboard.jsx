"use client";
import { useEffect, useRef, useState } from "react";
import { models as sampleModels, providers as sampleProviders, initialWorkspace, storageKey, routeCall, validWorkspace, money } from "../lib/demo";
import { API_BASE, ApiError, api, clearKey, downloadJSON, getMode, loadKey, loadWorkspace, saveKey, setMode, streamChat, toCatalogModel, toProvider, toReceiptRow, validKey } from "../lib/api";
import { connect, ensureChain, hasWallet, personalSign, sendTransactions, shortAddress } from "../lib/wallet";
import { Button, Modal, Code, CopyButton } from "./UI";
import ModelCatalog from "./ModelCatalog";

const tabs = ["Overview", "Playground", "Models", "API keys", "Receipts", "Payments", "Providers", "Settings"];
const tabId = (t) => t.toLowerCase().replace(" ", "-");
const publicTabs = ["Models", "Providers"];

function Field({ label, id, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/** Decimal token amount -> raw base units (exact, no floats). */
function toRaw(amount, decimals) {
  const [whole, frac = ""] = String(amount).trim().split(".");
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(frac) || frac.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}
const fromRaw = (raw, decimals) => Number(BigInt(raw || "0")) / 10 ** decimals;

function chainOf(status) {
  const c = status?.chain || {};
  return { id: c.chain_id, name: c.chain_id === 4663 ? "Robinhood Chain" : "Chain " + c.chain_id, rpc: c.public_rpc, explorer: c.explorer };
}

/** Settled swaps replace the accrual estimate with the exact token units and the swap transaction. */
function paidWithText(receipt, full) {
  const pw = full?.paid_with;
  if (!pw) return receipt.paidWith + (receipt.units ? " · " + receipt.units.toFixed(10) + " units" : "");
  const units = pw.raw_units ? (Number(pw.raw_units) / 10 ** (receipt.decimals ?? 18)).toFixed(10) : "0";
  return `${pw.token} · ${units} units · ${pw.status === "settled" ? "swapped in " + String(pw.swap_tx).slice(0, 12) + "…" : "accrued, swaps at the next settlement"}`;
}

// How often the router runs a periodic job, in words ("hourly", "every 2 minutes").
const cadence = (ms) => {
  if (!ms || ms === 3_600_000) return "hourly";
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000} hours`;
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "every minute" : `every ${m} minutes`;
};

function ReceiptDetails({ receipt, onClose, apiKey, status }) {
  const anchorEvery = cadence(status?.receipts?.anchor_interval_ms);
  const [checked, setChecked] = useState(false);
  const [full, setFull] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [error, setError] = useState("");
  const live = !!receipt.live;
  useEffect(() => {
    if (!live) return;
    api("/api/v1/generation?id=" + encodeURIComponent(receipt.id), { key: apiKey })
      .then((r) => setFull(r.data))
      .catch((e) => setError(e.message));
  }, [live, receipt.id, apiKey]);
  async function check() {
    setChecked(true);
    if (!live) return;
    if (!full) return setError("The receipt is still loading.");
    try {
      const anchor = full.anchor ? { root: full.anchor.root, proof: full.anchor.proof, index: full.anchor.index } : undefined;
      setVerdict((await api("/api/v1/receipts/verify", { method: "POST", body: { payload: full.receipt, sig: full.receipt_sig, key_id: full.receipt_key_id, anchor } })).data);
    } catch (e) {
      setError(e.message);
    }
  }
  const rows = [
    ["ID", receipt.id],
    ["Model", receipt.model],
    ["Provider", receipt.provider],
    ["Tokens", receipt.input + " input / " + receipt.output + " output"],
    ["Inference", money(receipt.inference, 8) + " USDG"],
    ["Creator royalty", money(receipt.royalty, 8) + " USDG"],
    ...(receipt.margin ? [["Per-call margin", money(receipt.margin, 8) + " USDG"]] : []),
    ["Total", money(receipt.cost, 8) + " USDG"],
    ["Paid with", paidWithText(receipt, full)],
    ["Route", live ? (receipt.private ? "Private · " + (full?.attestation_hash ? "attestation " + full.attestation_hash.slice(0, 18) + "…" : "attested provider") : "Standard") : receipt.private ? "Private fixture" : "Standard fixture"],
    ["Signature", live ? (full ? "Ed25519 · key " + full.receipt_key_id : "Loading…") : "Not connected"],
    ["Anchor", live ? (full ? (full.anchor ? `Batch #${full.anchor.index} · ${full.anchor.status}` : `Pending (anchored ${anchorEvery})`) : "Loading…") : "Not connected"],
  ];
  return (
    <Modal title="Generation receipt" onClose={onClose}>
      <span className={"badge" + (live ? " green" : "")}>{live ? (full ? (full.anchor ? "Signed · anchored" : "Signed · anchor pending") : receipt.status) : "Sample / not signed"}</span>
      <dl className="detail-list">
        {rows.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {checked && !live && (
        <div className="note" role="status">
          This sample contains no cryptographic signature or chain anchor. Its cost components add up, but it cannot establish provider identity, attestation or settlement.
        </div>
      )}
      {checked && live && verdict && (
        <div className={verdict.valid ? "success" : "error"} role="status">
          Signature {verdict.signature_valid ? "valid" : "INVALID"} (key from {verdict.key_source === "chain" ? "the on-chain registry" : "the router"}).{" "}
          {verdict.inclusion_valid == null ? `Not anchored yet: inclusion can be checked after the next anchor (${anchorEvery}).` : verdict.inclusion_valid ? "Included in the anchored batch" + (verdict.onchain_root ? ", root matches the chain." : ".") : "Anchor inclusion FAILED."} A valid receipt proves what the router recorded and charged; it does not by itself prove how the provider ran the model.
        </div>
      )}
      <div className="button-row">
        <Button onClick={() => downloadJSON(live ? full || receipt : receipt, receipt.id + ".json")}>Export JSON</Button>
        <Button secondary onClick={check}>
          Check proof status
        </Button>
      </div>
    </Modal>
  );
}

function ReceiptTable({ receipts, onInspect, emptyAction, live, emptyTitle, emptyText }) {
  return receipts.length ? (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Generation</th>
            <th>Route</th>
            <th className="num">Tokens</th>
            <th className="num">Cost / USDG</th>
            <th>Payment</th>
            <th>
              <span className="sr-only">Receipt</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((r, i) => (
            <tr key={r.id} style={{ "--i": Math.min(i, 12) }}>
              <td className="cell-primary">
                <strong>{r.model}</strong>
                <small>{new Date(r.time).toLocaleString("en-GB")}</small>
              </td>
              <td data-label="Route">
                <span className={"route-tag" + (r.private ? " private" : "")}>{r.private ? "Private" : "Standard"}</span>
                <small>{r.provider}</small>
              </td>
              <td className="num" data-label="Tokens">
                {r.tokens.toLocaleString("en-US")}
              </td>
              <td className="num" data-label="Cost / USDG">
                {money(r.cost, 6)}
              </td>
              <td data-label="Payment">{r.paidWith}</td>
              <td className="cell-action">
                <button className="text-button" onClick={() => onInspect(r)} aria-label={"Inspect receipt " + r.id}>
                  Inspect →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <h3>{emptyTitle || "No generations yet."}</h3>
      <p>{emptyText || (live ? "Your calls will appear here, each with a signed receipt." : "Your sample calls will appear here with an itemized receipt.")}</p>
      {emptyAction && <Button onClick={emptyAction}>Run your first call</Button>}
    </div>
  );
}

function KeyDialog({ existing, onSave, onClose, live }) {
  const [name, setName] = useState(existing?.name || "");
  const [budget, setBudget] = useState(existing?.budget == null ? (existing ? "" : "10") : String(existing.budget));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const noun = live ? "key" : "demo key";
  return (
    <Modal title={existing ? "Edit " + noun : "Create a " + noun} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const n = budget === "" && live ? null : Number(budget);
          if (!name.trim() || name.length > 60 || (n !== null && (!Number.isFinite(n) || n <= 0 || n > 100000))) {
            setError("Enter a name (up to 60 characters) and a budget greater than 0, up to 100,000 USDG" + (live ? " (leave empty for no budget limit)." : "."));
            return;
          }
          setBusy(true);
          try {
            await onSave({ name: name.trim(), budget: n });
          } catch (err) {
            setError(err.message);
            setBusy(false);
          }
        }}
      >
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <Field label="Key name" id="key-name">
          <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="e.g. Research agent" autoFocus />
        </Field>
        <Field label={live ? "Budget / USDG" : "Total demo budget / USDG"} id="key-budget">
          <input id="key-budget" type="number" min="0.000001" max="100000" step="any" value={budget} onChange={(e) => setBudget(e.target.value)} required={!live} placeholder={live ? "No limit" : undefined} />
        </Field>
        <div className="note">
          {live
            ? "Sub-keys share this workspace’s USDG balance and stop at their own budget. The secret is shown once; the router stores only its hash."
            : "Demo keys work only in this browser preview. They cannot authenticate with an API."}
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : existing ? "Save changes" : "Create " + noun}
        </Button>
      </form>
    </Modal>
  );
}

function SessionDialog({ onSave, onClose, existing, live, tokens = [], paywith = {} }) {
  const symbols = live ? tokens.map((t) => t.symbol) : ["NVDA", "TSLA"];
  const [token, setToken] = useState(existing?.token || symbols[0] || "NVDA");
  const [cap, setCap] = useState(String(existing?.cap ?? 0.01));
  const [error, setError] = useState("");
  const [step, setStep] = useState("");
  return (
    <Modal title={existing ? "Edit session cap" : live ? "Open a Stock Token session" : "Open a sample session"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const n = Number(cap);
          if (!Number.isFinite(n) || n <= 0 || n > 1000) {
            setError("Set a daily cap greater than 0 and up to 1,000 token units.");
            return;
          }
          if (live && !symbols.length) return setError("No Stock Tokens are registered on this router.");
          setError("");
          try {
            await onSave({ token, cap: n, cap_text: cap }, setStep);
          } catch (err) {
            setError(err?.message || String(err));
            setStep("");
          }
        }}
      >
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {step && (
          <div className="success" role="status">
            {step}
          </div>
        )}
        <Field label={live ? "Stock Token" : "Sample Stock Token"} id="session-token">
          <select id="session-token" disabled={!!existing || !!step} value={token} onChange={(e) => setToken(e.target.value)}>
            {symbols.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Daily cap / token units" id="session-cap">
          <input id="session-cap" type="number" min="0.0000000001" max="1000" step="any" value={cap} onChange={(e) => setCap(e.target.value)} required disabled={!!step} />
        </Field>
        <div className="note">
          {live
            ? `Your wallet approves the token and opens a capped session for this key (two transactions). Calls accrue in USDG; at $${paywith.threshold_usd ?? 1} (or after ${paywith.max_age_hours ?? 24}h) the router swaps exactly what is owed at the Chainlink fair value, never more than your daily cap. Close it any time.`
            : "No wallet is connected. Sample conversion values are NVDA = 100 USDG and TSLA = 200 USDG, purely for testing. No swap or transfer occurs."}
        </div>
        <Button type="submit" disabled={!!step}>
          {step ? "Working…" : existing ? "Save cap" : live ? "Connect wallet and open" : "Open sample session"}
        </Button>
      </form>
    </Modal>
  );
}

function SecretDialog({ secret, deposit, onClose, title = "Your new API key" }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>Copy this key now. It is shown once; the router stores only its hash.</p>
      <Code label="API key">{secret}</Code>
      {deposit?.key_hash && (
        <dl className="detail-list">
          <div>
            <dt>Deposit to</dt>
            <dd className="mono">{deposit.key_hash}</dd>
          </div>
          <div>
            <dt>Credits contract</dt>
            <dd className="mono">{deposit.credits_contract || "Not configured on this router"}</dd>
          </div>
        </dl>
      )}
      <div className="button-row modal-actions">
        <Button onClick={onClose}>I saved it</Button>
      </div>
    </Modal>
  );
}

function DepositDialog({ onClose, apiKey, credits, status, onDone }) {
  const [amount, setAmount] = useState("10");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const deposit = credits?.deposit || {};
  return (
    <Modal title="Deposit USDG" onClose={onClose}>
      <p>Add USDG to this key’s balance on {chainOf(status).name}. Prepaid calls carry a 0% router fee.</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {step && (
        <div className="success" role="status">
          {step}
        </div>
      )}
      <Field label="Amount / USDG" id="deposit-amount">
        <input id="deposit-amount" type="number" min="0.000001" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!!step} />
      </Field>
      <dl className="detail-list">
        <div>
          <dt>Key hash</dt>
          <dd className="mono">{deposit.key_hash}</dd>
        </div>
        <div>
          <dt>Credits contract</dt>
          <dd className="mono">{deposit.credits_contract || "Not configured on this router"}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd className="mono">{deposit.token}</dd>
        </div>
      </dl>
      <div className="button-row modal-actions">
        <Button
          disabled={!!step || !deposit.credits_contract}
          onClick={async () => {
            setError("");
            try {
              if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter a USDG amount with up to 6 decimals.");
              const from = await connect();
              await ensureChain(chainOf(status));
              const tx = (await api("/api/v1/credits/deposit-tx", { key: apiKey, method: "POST", body: { amount } })).data;
              await sendTransactions(from, tx.transactions, setStep);
              setStep("Deposited. Waiting for the router to index it…");
              await onDone(Number(amount));
            } catch (e) {
              setError(e?.message || String(e));
              setStep("");
            }
          }}
        >
          {hasWallet() ? "Deposit with wallet" : "Connect a wallet"}
        </Button>
        <CopyButton text={deposit.key_hash || ""} label="Copy key hash" />
      </div>
      <p className="help-text">No wallet here? Approve USDG to the Credits contract and call deposit(keyHash, amount) from any wallet.</p>
      {status?.dev_faucet && (
        <>
          <div className="note">Local test chain: add mock USDG to this key without a wallet. It has no value and exists only on this machine’s chain.</div>
          <div className="button-row modal-actions">
            <Button
              secondary
              disabled={!!step}
              onClick={async () => {
                setError("");
                try {
                  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 1000) throw new Error("Enter up to 1000 test USDG.");
                  setStep("Minting and depositing test USDG…");
                  await api("/api/v1/dev/faucet", { key: apiKey, method: "POST", body: { amount } });
                  await onDone(Number(amount), "test");
                } catch (e) {
                  setError(e?.message || String(e));
                  setStep("");
                }
              }}
            >
              Add {/^\d+(\.\d{1,6})?$/.test(amount) ? amount : "10"} test USDG
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function WithdrawDialog({ onClose, apiKey, credits, status, onDone }) {
  const rootEvery = cadence(status?.settlement?.spent_root_interval_ms);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false); // a wallet or API step is in flight (step also holds success messages)
  const [error, setError] = useState("");
  const [proof, setProof] = useState(null);
  // Pending state is read from the Credits contract, so reloading after each step reflects the chain.
  const loadProof = () =>
    api("/api/v1/credits/withdrawal-proof", { key: apiKey })
      .then((r) => setProof(r.data))
      .catch(() => setProof(null));
  useEffect(() => {
    loadProof();
  }, [apiKey]);
  const pending = proof?.pending;
  async function send(txs) {
    const from = await connect();
    await ensureChain(chainOf(status));
    if (!to) setTo(from);
    return { from, hashes: await sendTransactions(from, txs, setStep) };
  }
  return (
    <Modal title="Withdraw USDG" onClose={onClose}>
      <p>Your balance is self-custodial. A withdrawal is requested with this key’s signature, then finalized with a proof from the next spent root (posted {rootEvery}).</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {step && (
        <div className="success" role="status">
          {step}
        </div>
      )}
      {pending ? (
        <>
          <div className="note">
            Pending request: {money(fromRaw(pending.amount_usdg_units, 6), 6)} USDG to {shortAddress(pending.to)} (requested {new Date(pending.requested_at).toLocaleString("en-GB")}). Finalize once a spent root newer than the request is posted.
          </div>
          <div className="button-row modal-actions">
            <Button
              disabled={busy || !proof?.transactions?.length || new Date(proof.as_of) < new Date(pending.requested_at)}
              onClick={async () => {
                setError("");
                setBusy(true);
                try {
                  await send(proof.transactions);
                  await Promise.all([onDone(), loadProof()]);
                  setStep("Withdrawal finalized. USDG has been sent.");
                } catch (e) {
                  setError(e?.message || String(e));
                  setStep("");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Finalize withdrawal
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={async () => {
                setError("");
                setBusy(true);
                try {
                  const req = (await api("/api/v1/credits/withdraw-cancel", { key: apiKey, method: "POST" })).data;
                  await send(req.transactions);
                  await loadProof();
                  setStep("Withdrawal cancelled. The locked amount returns to your balance within a few seconds.");
                  await onDone();
                  setTimeout(() => onDone(), 6000);
                } catch (e) {
                  setError(e?.message || String(e));
                  setStep("");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Cancel request
            </Button>
          </div>
          {proof && new Date(proof.as_of) < new Date(pending.requested_at) && <p className="help-text">The latest spent root ({new Date(proof.as_of).toLocaleString("en-GB")}) predates the request. Try again after the next root (posted {rootEvery}).</p>}
        </>
      ) : (
        <>
          <Field label="Amount / USDG" id="withdraw-amount">
            <input id="withdraw-amount" type="number" min="0.000001" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} placeholder={money(credits?.available ?? 0, 2)} />
          </Field>
          <Field label="Send to (defaults to your connected wallet)" id="withdraw-to">
            <input id="withdraw-to" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" disabled={busy} />
          </Field>
          <div className="button-row modal-actions">
            <Button
              disabled={busy}
              onClick={async () => {
                setError("");
                setBusy(true);
                try {
                  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter a USDG amount with up to 6 decimals.");
                  const from = await connect();
                  const dest = to || from;
                  if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) throw new Error("Enter a valid destination address.");
                  const req = (await api("/api/v1/credits/withdraw-request", { key: apiKey, method: "POST", body: { amount, to: dest } })).data;
                  await ensureChain(chainOf(status));
                  await sendTransactions(from, req.transactions, setStep);
                  await Promise.all([onDone(), loadProof()]);
                  setStep(`Withdrawal requested. The amount is locked now; finalize after the next spent root (posted ${rootEvery}).`);
                  setTimeout(() => onDone(), 6000); // the lock shows in the balance once the router indexes it
                } catch (e) {
                  setError(e?.message || String(e));
                  setStep("");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Request withdrawal
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
