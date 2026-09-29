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

/** How long escrow credits wait for the chain to finalize a transfer, in words. */
const finalityWait = (escrow) => {
  const s = Number(escrow?.expected_credit_delay_s);
  if (!Number.isFinite(s) || s <= 0) return "once the chain finalizes the transfer";
  const m = Math.max(1, Math.round(s / 60));
  return `once the chain finalizes the transfer (about ${m} minute${m === 1 ? "" : "s"})`;
};
const DEPOSIT_STATUS = {
  pending_finality: ["Waiting for finality", ""],
  pending: ["Pricing", ""],
  credited: ["Credited", " green"],
  orphaned: ["Dropped by the chain · not credited", ""],
  reversed: ["Reversed", ""],
};

/** ERC-20 transfer(to, raw) calldata, built without a library. */
const transferData = (to, raw) => "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + BigInt(raw).toString(16).padStart(64, "0");

function StockDepositDialog({ onClose, escrow, stock, status, onDone }) {
  const tokens = escrow?.tokens || [];
  const [symbol, setSymbol] = useState(tokens.find((t) => t.credit_usd_per_token)?.symbol || tokens[0]?.symbol || "");
  const [amount, setAmount] = useState("1");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const token = tokens.find((t) => t.symbol === symbol);
  const wallet = stock?.wallet || "";
  const estimate = token?.credit_usd_per_token && Number(amount) > 0 ? Number(amount) * token.credit_usd_per_token : null;
  const discount = (escrow?.haircut_bps ?? 0) / 100;
  return (
    <Modal title="Pay with stock" onClose={onClose}>
      <p>
        Send a listed Stock Token on {chainOf(status).name} to the escrow wallet. Your balance is credited {finalityWait(escrow)} at the live Chainlink
        price{discount ? ` minus ${discount}%` : ""}. Credits are spent on API calls and are not withdrawable.
      </p>
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
      {!wallet ? (
        <div className="note">Deposits are credited to the wallet that sends them. Sign out, then choose “Sign in with wallet” using the wallet you will send from.</div>
      ) : (
        <>
          <div className="two-fields">
            <Field label="Stock Token" id="stock-token">
              <select id="stock-token" value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={!!step}>
                {tokens.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                    {t.price_usd ? ` · $${t.price_usd.toFixed(2)}` : " · price paused"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={"Amount / " + (symbol || "tokens")} id="stock-amount">
              <input id="stock-amount" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!!step} />
            </Field>
          </div>
          <dl className="detail-list">
            <div>
              <dt>You receive</dt>
              <dd>{estimate != null ? `≈ $${money(estimate, 2)} in credits` : "Credited when the price updates (markets closed or feed paused)"}</dd>
            </div>
            <div>
              <dt>Send from</dt>
              <dd className="mono">{wallet}</dd>
            </div>
            <div>
              <dt>Escrow wallet</dt>
              <dd className="mono">{escrow?.address}</dd>
            </div>
            {token && (
              <div>
                <dt>{token.symbol} contract</dt>
                <dd className="mono">{token.address}</dd>
              </div>
            )}
          </dl>
          <div className="button-row modal-actions">
            <Button
              disabled={!!step || !token}
              onClick={async () => {
                setError("");
                try {
                  const raw = toRaw(amount, token.decimals);
                  if (BigInt(raw) <= 0n) throw new Error("Enter an amount above zero.");
                  const from = await connect();
                  if (from.toLowerCase() !== wallet.toLowerCase()) throw new Error(`Switch your wallet to ${shortAddress(wallet)}, the wallet you signed in with. Tokens sent from another wallet are credited to that wallet.`);
                  await ensureChain(chainOf(status));
                  await sendTransactions(from, [{ to: token.address, data: transferData(escrow.address, raw), description: `Send ${amount} ${token.symbol} to escrow` }], setStep);
                  setStep("Sent. Waiting for the router to see the transfer…");
                  await onDone();
                } catch (e) {
                  setError(e?.message || String(e));
                  setStep("");
                }
              }}
            >
              {hasWallet() ? `Send ${token?.symbol || ""} with wallet` : "Connect a wallet"}
            </Button>
            <CopyButton text={escrow?.address || ""} label="Copy escrow address" />
          </div>
          <p className="help-text">Any wallet app works: send a listed token from {shortAddress(wallet)} to the escrow address. Tokens sent from an exchange or another wallet are credited to that sender, not to you.</p>
        </>
      )}
    </Modal>
  );
}

function StockDeposits({ deposits }) {
  return deposits?.length ? (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Deposit</th>
            <th className="num">Amount</th>
            <th className="num">Credited</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {deposits.map((d, i) => (
            <tr key={d.id} style={{ "--i": Math.min(i, 12) }}>
              <td className="cell-primary">
                <strong className="mono">{d.tx_hash.slice(0, 12)}…</strong>
                <small>{new Date(d.at).toLocaleString("en-GB")}</small>
              </td>
              <td className="num" data-label="Amount">
                {d.amount} {d.symbol}
              </td>
              <td className="num" data-label="Credited">
                {d.credited_usd != null ? "$" + money(d.credited_usd, 2) : "—"}
              </td>
              <td data-label="Status">
                <span className={"badge" + (DEPOSIT_STATUS[d.status]?.[1] ?? "")}>{DEPOSIT_STATUS[d.status]?.[0] ?? "Waiting"}</span>
                {d.note && <small>{d.note}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <h3>No stock deposits yet.</h3>
      <p>Send a listed Stock Token to the escrow wallet and it appears here once confirmed.</p>
    </div>
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

function SignIn({ onKey, onDemo, onSecret, stockMode }) {
  const [value, setValue] = useState("");
  const remember = false;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  async function run(label, fn) {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="signin-panel" aria-labelledby="signin-title">
      <div className="signin-copy">
        <span className="eyebrow">Live workspace</span>
        <h2 id="signin-title">Connect your workspace</h2>
        <p>
          {stockMode
            ? "Sign in with your wallet, send a listed Stock Token to the escrow wallet and start calling. No account, email or password."
            : "Anyroute keys are self-custodial: create a key, deposit USDG to it and start calling. No account, email or password."}
        </p>
        <button className="text-button" onClick={onDemo}>
          Explore the sample workspace instead →
        </button>
        <div className="scan-rule" aria-hidden="true" />
      </div>
      <div className="signin-form">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!validKey(value)) return setError("That is not an Anyroute key (sk-ar-v1- followed by 64 hex characters).");
            run("key", () => onKey(value.trim(), remember));
          }}
        >
          <Field label="API key" id="signin-key">
            <input id="signin-key" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-ar-v1-…" />
          </Field>
          <div className="button-row">
            <Button type="submit" disabled={!!busy}>
              {busy === "key" ? "Connecting…" : "Connect key"}
            </Button>
            {!stockMode && (
            <Button
              type="button"
              secondary
              disabled={!!busy}
              onClick={() =>
                run("new", async () => {
                  const r = await api("/api/v1/keys", { method: "POST", body: { name: "Workspace key" } });
                  onSecret(r.key, r.deposit);
                  await onKey(r.key, remember);
                })
              }
            >
              {busy === "new" ? "Creating…" : "Create a new key"}
            </Button>
            )}
            {(stockMode || hasWallet()) && (
              <Button
                type="button"
                secondary
                disabled={!!busy}
                onClick={() =>
                  run("wallet", async () => {
                    const address = await connect();
                    const { data: challenge } = await api("/api/v1/auth/wallet/challenge", { method: "POST", body: { address } });
                    const signature = await personalSign(address, challenge.message);
                    const r = await api("/api/v1/auth/wallet", { method: "POST", body: { address, nonce: challenge.nonce, signature, name: "Wallet key" } });
                    onSecret(r.key, null, "Your wallet’s API key");
                    await onKey(r.key, remember);
                  })
                }
              >
                {busy === "wallet" ? "Waiting for signature…" : "Sign in with wallet"}
              </Button>
            )}
          </div>
        </form>
        <p className="help-text">Keys stay in this browser (this tab session only). Prompts are never stored.</p>
      </div>
    </section>
  );
}

export default function Dashboard() {
  // ---- mode & connection ----
  const [mode, setModeState] = useState(null); // "live" | "demo"
  const [connection, setConnection] = useState("checking"); // checking | ok | unreachable
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [ws, setWs] = useState(null); // live workspace
  const [secrets, setSecrets] = useState({}); // key hash -> secret, for keys created in this session
  const [catalog, setCatalog] = useState([]);
  const [liveProviders, setLiveProviders] = useState(null);
  const [stockMode, setStockMode] = useState(false); // the router takes Stock Token escrow payments
  const [reveal, setReveal] = useState(null);
  // ---- sample workspace (explicit demo mode) ----
  const [state, setState] = useState(initialWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState("");
  // ---- shared UI ----
  const [tab, setTab] = useState("Overview");
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState("");
  const [modelId, setModelId] = useState(sampleModels[0].id);
  const [prompt, setPrompt] = useState("Explain how a generation receipt makes AI usage easier to audit.");
  const [privateRoute, setPrivate] = useState(false);
  const [payWith, setPayWith] = useState("USDG");
  const [keyId, setKeyId] = useState("key_seed");
  const [forceFailure, setForceFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState("");
  const [result, setResult] = useState(null);
  const [streamText, setStreamText] = useState("");
  const [receiptQuery, setReceiptQuery] = useState("");
  const [receiptMode, setReceiptMode] = useState("All");
  const lock = useRef(false);
  const timer = useRef(null);
  const abort = useRef(null);
  const navRef = useRef(null);
  const sectionRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const live = mode === "live";
  const escrowOn = live && !!ws?.escrow; // PAYMENTS_MODE=escrow: Stock Tokens sent to an escrow wallet become credits

  async function refresh(key = apiKey) {
    const next = await loadWorkspace(key);
    setWs(next);
    return next;
  }
  async function signInWith(key, remember) {
    const next = await loadWorkspace(key);
    saveKey(key, remember);
    setApiKey(key);
    setWs(next);
    setKeyId(next.me.hash);
    setSecrets((s) => ({ ...s, [next.me.hash]: key }));
    setNotice("Connected with " + next.me.label + ".");
  }
  async function connectLive() {
    setConnection("checking");
    try {
      const s = await api("/api/v1/status");
      setStatus(s.data);
      setConnection("ok");
      api("/api/v1/models").then((r) => setCatalog(r.data.map(toCatalogModel))).catch(() => setCatalog([]));
      api("/api/v1/escrow").then((r) => setStockMode(!!r.data?.enabled)).catch(() => setStockMode(false));
      const stored = loadKey();
      if (stored) {
        try {
          const next = await loadWorkspace(stored);
          setApiKey(stored);
          setWs(next);
          setKeyId(next.me.hash);
          setSecrets((x) => ({ ...x, [next.me.hash]: stored }));
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) clearKey();
          else setError(e.message);
        }
      }
    } catch {
      setConnection("unreachable");
    }
  }

  useEffect(() => {
    const m = getMode();
    setModeState(m);
    if (m === "live") connectLive().finally(() => setLoaded(true));
    else {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (validWorkspace(parsed)) {
            setState(parsed);
            setKeyId(parsed.keys.find((k) => k.active)?.id || "");
          } else setStorageError("The saved workspace could not be read. A fresh in-memory sample is open; reset it in Settings to resume saving.");
        }
      } catch {
        setStorageError("Browser storage is unavailable or contains unreadable data. Changes will stay in memory for this visit.");
      }
      setLoaded(true);
    }
    const selectHash = () => {
      const match = tabs.find((t) => tabId(t) === window.location.hash.slice(1));
      setTab(match || "Overview");
    };
    selectHash();
    const model = new URLSearchParams(window.location.search).get("model");
    if (model) setModelId(model);
    window.addEventListener("hashchange", selectHash);
    return () => {
      window.removeEventListener("hashchange", selectHash);
      clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (mode !== "demo" || !loaded || storageError) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      setStorageError("This browser could not save the workspace. Changes remain available for this visit.");
    }
  }, [state, loaded, storageError, mode]);
  useEffect(() => {
    if (live && connection === "ok" && tab === "Providers" && !liveProviders)
      api("/api/v1/providers")
        .then((r) => setLiveProviders(r.data.map(toProvider)))
        .catch((e) => setError(e.message));
  }, [live, connection, tab, liveProviders]);
  useEffect(() => {
    if (live && catalog.length && !catalog.some((m) => m.id === modelId)) setModelId(catalog.find((m) => m.type !== "Embeddings")?.id || catalog[0].id);
  }, [live, catalog, modelId]);
  // Keep the selected section visible in the horizontally scrolling tab bar (phones).
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector("[aria-current]");
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    const left = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [tab]);

  // Hash links select a workspace section and move assistive-technology focus
  // once its content is ready, including on direct links and browser Back/Forward.
  useEffect(() => {
    if (loaded && window.location.hash === "#" + tabId(tab)) {
      const frame = requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
  }, [tab, loaded]);

  function switchMode(next) {
    setMode(next);
    window.location.reload();
  }
  function navigate(next) {
    window.location.hash = tabId(next);
    setTab(next);
    setNotice("");
    setError("");
  }
  function update(fn) {
    setState((previous) => {
      const next = fn(previous);
      stateRef.current = next;
      return next;
    });
  }

  // ---- normalized view (same shapes for both workspaces) ----
  const decimalsOf = (sym) => ws?.tokens?.find((t) => t.symbol === sym)?.decimals ?? 18;
  const liveKeys = (ws?.keys || []).map((k) => ({
    id: k.hash,
    name: k.name || k.label,
    token: k.label,
    budget: k.limit,
    spent: k.usage_period ?? k.usage ?? 0,
    active: !k.disabled,
    chainKeyHash: k.chain_key_hash,
    current: k.hash === ws?.me?.hash,
    secret: secrets[k.hash],
  }));
  const liveSession = ws?.session
    ? {
        id: "session",
        token: ws.session.symbol,
        cap: fromRaw(ws.session.cap_raw_per_day, ws.session.decimals),
        spent: fromRaw(ws.session.spent_raw_today, ws.session.decimals),
        active: ws.session.active && ws.session.pay_with_default === ws.session.symbol,
        open: ws.session.active,
        wallet: ws.session.wallet,
        debt: ws.session.open_debt_usd,
        day: new Date().toISOString().slice(0, 10),
      }
    : null;
  const view = live
    ? { balance: ws?.credits?.available ?? 0, keys: liveKeys, sessions: liveSession ? [liveSession] : [], receipts: ws?.receipts || [] }
    : { balance: state.balance, keys: state.keys, sessions: state.sessions, receipts: state.receipts };
  const playModels = live ? catalog.filter((m) => m.type !== "Embeddings") : sampleModels;
  const payOptions = live ? ["USDG", ...(ws?.tokens || []).map((t) => t.symbol)] : ["USDG", "NVDA", "TSLA"];
  const providerRows = live ? liveProviders || [] : sampleProviders;
  const signedIn = !live || (!!apiKey && !!ws);

  // ---- actions ----
  function run(e) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setStreamText("");
    if (!live) {
      const args = { modelId, prompt, privateRoute, payWith, keyId, forceFailure };
      timer.current = setTimeout(() => {
        try {
          const outcome = routeCall({ state: stateRef.current, ...args });
          stateRef.current = outcome.state;
          setState(outcome.state);
          setResult(outcome.receipt);
          setNotice("Sample call completed. Its receipt is ready.");
        } catch (err) {
          setError(err.message);
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }, 750);
      return;
    }
    const k = view.keys.find((x) => x.id === keyId);
    const ctl = new AbortController();
    abort.current = ctl;
    setErrorKind("");
    (async () => {
      try {
        if (!k?.secret) throw new Error("Choose a key whose secret is available in this browser (your signed-in key or one created this session).");
        if (!prompt.trim()) throw new Error("Enter a prompt before routing a call.");
        const out = await streamChat({ key: k.secret, body: liveRequest.body, headers: liveRequest.headers, signal: ctl.signal, onDelta: setStreamText });
        const g = (await api("/api/v1/generation?id=" + encodeURIComponent(out.id), { key: k.secret })).data;
        setResult({ ...toReceiptRow({ ...g, anchored: !!g.anchor, created_at: g.created_at }, ws?.tokens), text: out.text });
        setNotice(out.error ? "The provider stopped mid-stream; the delivered part was billed. Its receipt is ready." : "Call completed. Its signed receipt is ready.");
        refresh().catch(() => {});
      } catch (err) {
        if (err?.name === "AbortError") return;
        const hint = err?.metadata?.pay_with ? " (" + err.metadata.pay_with + ")" : "";
        setErrorKind(err?.type || "");
        setError(err.message + hint);
      } finally {
        lock.current = false;
        setBusy(false);
      }
    })();
  }
  function cancel() {
    if (!live) {
      clearTimeout(timer.current);
      lock.current = false;
      setBusy(false);
      setError("Sample request cancelled. No balance or budget was spent.");
      return;
    }
    abort.current?.abort();
    lock.current = false;
    setBusy(false);
    setError("Request cancelled. Anything the provider already generated is billed and appears in Receipts.");
    setTimeout(() => refresh().catch(() => {}), 1500);
  }
  async function saveKeyValues(values) {
    if (!live) {
      if (modal.data) update((s) => ({ ...s, keys: s.keys.map((k) => (k.id === modal.data.id ? { ...k, ...values } : k)) }));
      else {
        const id = crypto.randomUUID();
        update((s) => ({ ...s, keys: [...s.keys, { ...values, id, token: "demo_anyr_" + id.replaceAll("-", "").slice(0, 20), spent: 0, active: true }] }));
        setKeyId(id);
      }
      setNotice(modal.data ? "Demo key updated." : "Demo key created. It is not a production credential.");
      setModal(null);
      return;
    }
    if (modal.data) {
      await api("/api/v1/keys/" + modal.data.id, { key: apiKey, method: "PATCH", body: { name: values.name, limit: values.budget } });
      setNotice("Key updated.");
    } else {
      const r = await api("/api/v1/keys", { key: apiKey, method: "POST", body: { name: values.name, limit: values.budget } });
      setSecrets((s) => ({ ...s, [r.data.hash]: r.key }));
      setReveal({ secret: r.key, deposit: r.deposit });
      setNotice("Key created. Copy its secret now; it is shown once.");
    }
    setModal(null);
    await refresh();
  }
  async function saveSession(values, onStep) {
    if (!live) {
      const existing = modal.data || state.sessions.find((s) => s.token === values.token);
      update((s) => ({
        ...s,
        sessions: existing
          ? s.sessions.map((x) => (x.id === existing.id ? { ...x, ...values, active: true } : x))
          : [...s.sessions, { ...values, id: crypto.randomUUID(), active: true, spent: 0, day: new Date().toISOString().slice(0, 10) }],
      }));
      setNotice("Sample session saved. No wallet permission or transaction was created.");
      setModal(null);
      return;
    }
    const wallet = await connect();
    await ensureChain(chainOf(status));
    const raw = toRaw(values.cap_text, decimalsOf(values.token));
    const open = (await api("/api/v1/paywith/open", { key: apiKey, method: "POST", body: { token: values.token, cap_raw_per_day: raw, wallet } })).data;
    await sendTransactions(wallet, open.transactions, onStep);
    onStep("Session opened. Waiting for the router to index it…");
    await api("/api/v1/keys/" + ws.me.hash, { key: apiKey, method: "PATCH", body: { pay_with_default: values.token } }).catch(() => {});
    for (let i = 0; i < 30; i++) {
      const next = await refresh();
      if (next.session?.active) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    setPayWith(values.token);
    setNotice(`${values.token} session is open with a daily cap of ${values.cap_text} ${values.token}.`);
    setModal(null);
  }
  async function toggleSession(s) {
    if (!live) {
      update((w) => ({ ...w, sessions: w.sessions.map((x) => (x.id === s.id ? { ...x, active: !x.active } : x)) }));
      setNotice(s.active ? "Sample session paused." : "Sample session resumed.");
      return;
    }
    try {
      await api("/api/v1/keys/" + ws.me.hash, { key: apiKey, method: "PATCH", body: { pay_with_default: s.active ? null : s.token } });
      await refresh();
      setNotice(s.active ? `Paused: calls from this key pay in USDG unless they send X-Pay-With: ${s.token}.` : `Resumed: calls from this key pay with ${s.token} by default.`);
    } catch (e) {
      setError(e.message);
    }
  }
  async function confirmAction() {
    if (modal.type === "reset") {
      if (live) {
        clearKey();
        setApiKey("");
        setWs(null);
        setSecrets({});
        setResult(null);
        setNotice("Signed out of this browser. Your key and balance are unchanged.");
      } else {
        setState(structuredClone(initialWorkspace));
        setStorageError("");
        setResult(null);
        setKeyId("key_seed");
        setPayWith("USDG");
        setNotice("Sample workspace reset.");
      }
    } else if (modal.type === "revoke") {
      if (live) {
        await api("/api/v1/keys/" + modal.data.id, { key: apiKey, method: "DELETE" });
        await refresh();
        setNotice("Key revoked. It stops working immediately.");
      } else {
        update((s) => ({ ...s, keys: s.keys.map((k) => (k.id === modal.data.id ? { ...k, active: false } : k)) }));
        setNotice("Demo key revoked.");
      }
    } else if (live) {
      const wallet = await connect();
      await ensureChain(chainOf(status));
      const tx = (await api("/api/v1/paywith/close", { key: apiKey, method: "POST" })).data;
      await sendTransactions(wallet, tx.transactions);
      for (let i = 0; i < 30; i++) {
        const next = await refresh();
        if (!next.session?.active) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (payWith !== "USDG") setPayWith("USDG");
      setNotice("Session closed on-chain. Any accrued debt is still settled from it.");
    } else {
      update((s) => ({ ...s, sessions: s.sessions.filter((x) => x.id !== modal.data.id) }));
      setNotice("Sample session closed.");
    }
    setModal(null);
  }

  const total = live ? (ws?.credits?.total_usage ?? 0) : view.receipts.reduce((s, r) => s + r.cost, 0);
  const tokens = view.receipts.reduce((s, r) => s + r.tokens, 0);
  const filtered = view.receipts.filter(
    (r) => (r.id + " " + r.model + " " + r.provider).toLowerCase().includes(receiptQuery.toLowerCase()) && (receiptMode === "All" || (receiptMode === "Private" ? r.private : !r.private)),
  );
  const stats = [
    [live ? "Available USDG" : "USDG balance", money(view.balance, 4), live ? "Prepaid · 0% router fee" : "Sample credits"],
    ["Calls routed", String(view.receipts.length), live ? "Latest " + view.receipts.length : "This browser"],
    ["Tokens processed", tokens.toLocaleString("en-US"), live ? "Metered by providers" : "Sample usage"],
    ["Total cost", money(total, 6), live ? "USDG · all time" : "USDG · illustrative"],
  ];
  const sampleRequest = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    provider: { private: privateRoute, allow_fallbacks: true },
    ...(payWith !== "USDG" ? { headers: { "X-Pay-With": payWith } } : {}),
  };
  const liveRequest = {
    headers: payWith !== "USDG" ? { "X-Pay-With": payWith } : {},
    body: { model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: 512, provider: { ...(privateRoute ? { private: true } : {}), allow_fallbacks: !forceFailure } },
  };
  const origin = typeof window !== "undefined" ? API_BASE || window.location.origin : "";
  const currentKey = liveKeys.find((k) => k.current);
  // Until the mode is read from the URL and storage, label nothing as live or sample.
  const booting = mode === null;
  const workspaceState = booting ? "loading" : !live ? "demo" : connection;

  return (
    <main className="dashboard-main" id="content" data-workspace={workspaceState}>
      <div className="dashboard-heading">
        <div>
          <span className="eyebrow">ANYROUTE WORKSPACE</span>
          <h1>Your routes, in detail.</h1>
        </div>
        <span className="badge dark workspace-status" data-state={workspaceState}>
          <span className="live-square" />
          {booting ? "LOADING" : live ? (connection === "ok" ? "LIVE · CHAIN " + (status?.chain?.chain_id ?? "") : connection === "unreachable" ? "API UNREACHABLE" : "CONNECTING") : "SAMPLE WORKSPACE"}
        </span>
      </div>
      <div className="workspace-notice" data-state={workspaceState}>
        {booting ? (
          "Loading workspace…"
        ) : live ? (
          signedIn && ws ? (
            <>
              Live workspace · Signed in with {ws.me.label} · Balance, keys and receipts come from the Anyroute API.{" "}
              <button className="text-button" onClick={() => navigate("Settings")}>
                Manage →
              </button>
            </>
          ) : connection === "unreachable" ? (
            "Live workspace · The router did not respond, so no balance, keys or receipts are shown."
          ) : (
            "Live workspace · Connect a key to see your balance, keys and receipts."
          )
        ) : (
          <>
            Sample workspace · All activity stays in this browser. No live inference, wallet or payments.{" "}
            <button className="text-button" onClick={() => switchMode("live")}>
              Switch to your live workspace →
            </button>
          </>
        )}
      </div>
      <nav className="dashboard-nav" aria-label="Workspace sections" ref={navRef}>
        {tabs.map((t) => (
          <a key={t} href={"#" + tabId(t)} aria-current={tab === t ? "page" : undefined} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate(t);
          }}>
            {t}
          </a>
        ))}
      </nav>
      <section ref={sectionRef} className="dashboard-section" tabIndex={-1} aria-label={`${tab} workspace section`}>
      {tabs.map((t) => <span key={t} id={tabId(t)} className="dashboard-anchor" aria-hidden="true" />)}
      {storageError && (
        <div className="error" role="alert">
          {storageError}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {!loaded ? (
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          {mode === "demo" ? "Loading sample workspace…" : "Connecting to Anyroute…"}
        </div>
      ) : live && connection === "unreachable" ? (
        <section className="router-status dark" aria-labelledby="router-status-title">
          <span className="empty-grid" aria-hidden="true" />
          <div className="router-status-head">
            <span className="status-dot" aria-hidden="true" />
            <span>No response</span>
            <code>GET {origin || ""}/api/v1/status</code>
          </div>
          <h2 id="router-status-title">The Anyroute API is not reachable.</h2>
          <p>
            Tried {origin || "this site"}/api/v1. Your balance and receipts are safe; this page just cannot reach the router right now. Nothing is shown from sample data unless you choose it.
          </p>
          <div className="button-row">
            <Button light onClick={() => connectLive()}>
              Retry
            </Button>
            <Button secondary onClick={() => switchMode("demo")}>
              Open the sample workspace
            </Button>
          </div>
        </section>
      ) : live && !signedIn && !publicTabs.includes(tab) ? (
        <div className="tab-panel" key="signin">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <SignIn stockMode={stockMode} onKey={signInWith} onDemo={() => switchMode("demo")} onSecret={(secret, deposit, title) => setReveal({ secret, deposit, title })} />
        </div>
      ) : (
        <div className="tab-panel" key={tab}>
          {tab === "Overview" && (
            <>
              <div className="metric-grid">
                {stats.map(([label, value, sub], i) => (
                  <article className="metric" key={label} style={{ "--i": i }}>
                    <span className="eyebrow">{label}</span>
                    <strong>{value}</strong>
                    <span>{sub}</span>
                  </article>
                ))}
              </div>
              <div className="overview-grid">
                <section className="usage-panel">
                  <div className="panel-heading">
                    <h2>Usage by generation</h2>
                    <span className="eyebrow">{live ? "METERED TOKENS" : "SAMPLE TOKENS"}</span>
                  </div>
                  {view.receipts.length ? (
                    <>
                      <div className="usage-chart" role="img" aria-label={view.receipts.length + (live ? " generations using " : " sample generations using ") + tokens + " tokens"}>
                        {view.receipts
                          .slice(0, 30)
                          .reverse()
                          .map((r, i) => (
                            <div key={r.id} title={r.model + ": " + r.tokens + " tokens"} style={{ "--i": i, height: Math.max(5, (100 * r.tokens) / Math.max(1, ...view.receipts.map((x) => x.tokens))) + "%" }} />
                          ))}
                      </div>
                      <div className="usage-axis" aria-hidden="true">
                        <span>Earlier</span>
                        <span>Latest {Math.min(30, view.receipts.length)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="usage-empty">
                      <span className="empty-grid" aria-hidden="true" />
                      <span>Your first route starts here.</span>
                      <button className="text-button" onClick={() => navigate("Playground")}>
                        {live ? "Run a call →" : "Run a sample call →"}
                      </button>
                    </div>
                  )}
                </section>
                <section className="quickstart-card">
                  <span className="eyebrow">ONE KEY. ONE BALANCE.</span>
                  <h2>
                    Make a call.
                    <br />
                    Follow the receipt.
                  </h2>
                  <p>Choose a model, set your route and inspect every cost line.</p>
                  <Button light onClick={() => navigate("Playground")}>
                    Open playground
                  </Button>
                  <div className="scan-rule" aria-hidden="true" />
                </section>
              </div>
              <div className="panel-heading">
                <h2>Recent generations</h2>
                <button className="text-button" onClick={() => navigate("Receipts")}>
                  View all receipts →
                </button>
              </div>
              <ReceiptTable live={live} receipts={view.receipts.slice(0, 5)} onInspect={(r) => setModal({ type: "receipt", data: r })} emptyAction={() => navigate("Playground")} />
            </>
          )}
          {tab === "Playground" && (
            <>
              <div className="panel-heading">
                <h2>{live ? "Route a call." : "Route a sample call."}</h2>
                <span className="badge">{live ? "Live request · billed to the selected key" : "No external request"}</span>
              </div>
              <div className="playground-grid">
                <form className="control-panel" onSubmit={run}>
                  <Field label="Model" id="play-model">
                    <select id="play-model" value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={busy}>
                      {playModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {live ? m.id : m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="two-fields">
                    <Field label={live ? "Key" : "Demo key"} id="play-key">
                      <select id="play-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} disabled={busy}>
                        <option value="">Select key</option>
                        {view.keys
                          .filter((k) => k.active && (!live || k.secret))
                          .map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="Pay with" id="play-payment">
                      <select id="play-payment" value={payWith} onChange={(e) => setPayWith(e.target.value)} disabled={busy}>
                        {payOptions.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <label className="check-label">
                    <input type="checkbox" checked={privateRoute} onChange={(e) => setPrivate(e.target.checked)} disabled={busy} /> Require an attested private route
                  </label>
                  <Field label={live ? "Prompt" : "Sample prompt"} id="play-prompt">
                    <textarea id="play-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} disabled={busy} />
                  </Field>
                  <p className="help-text">{live ? "Streams a real completion (up to 512 tokens). Prompts and responses are never stored." : "The demo returns a fixed sample response. Prompt text is not saved."}</p>
                  <details className="failure-option">
                    <summary>{live ? "Routing options" : "Test a failure state"}</summary>
                    <label className="check-label">
                      <input type="checkbox" checked={forceFailure} onChange={(e) => setForceFailure(e.target.checked)} disabled={busy} /> {live ? "Disallow fallbacks (allow_fallbacks: false)" : "Simulate provider timeout"}
                    </label>
                  </details>
                  {error && (
                    <div className="error" role="alert">
                      {error}
                      {live && errorKind === "insufficient_credits" && (
                        <>
                          {" "}
                          <button type="button" className="text-button" onClick={() => setModal({ type: escrowOn ? "stock" : "credits" })}>
                            {escrowOn ? "Pay with stock →" : "Deposit USDG →"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  <div className="button-row">
                    <Button type="submit" disabled={busy}>
                      {busy ? (live ? "Routing…" : "Routing sample…") : live ? "Run call" : "Run sample call"}
                    </Button>
                    {busy && (
                      <Button secondary type="button" onClick={cancel}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </form>
                <div className="playground-output">
                  <Code label="Request preview">
                    {live
                      ? JSON.stringify({ url: origin + "/api/v1/chat/completions", headers: { Authorization: "Bearer " + (view.keys.find((k) => k.id === keyId)?.token || "sk-ar-v1-…"), ...liveRequest.headers }, body: liveRequest.body }, null, 2)
                      : JSON.stringify(sampleRequest, null, 2)}
                  </Code>
                  <div className={"response-panel" + (busy ? " is-busy" : "")} aria-live="polite" aria-busy={busy || undefined}>
                    <span className="eyebrow">{busy ? (live ? "STREAMING…" : "ROUTING…") : live ? "RESPONSE" : "SAMPLE RESPONSE"}</span>
                    {live && (busy || result) && (streamText || result?.text) ? (
                      <>
                        <p style={{ whiteSpace: "pre-wrap" }}>{result?.text ?? streamText}</p>
                        {result && (
                          <>
                            <div className="model-meta">
                              <span>{result.tokens} tokens</span>
                              <span>{money(result.cost, 6)} USDG</span>
                            </div>
                            <button className="text-button" onClick={() => setModal({ type: "receipt", data: result })}>
                              Inspect generation receipt →
                            </button>
                          </>
                        )}
                      </>
                    ) : result ? (
                      <>
                        <p>A generation receipt makes usage easier to audit by recording the model, provider, token counts, payment allocation and cost components for one call.</p>
                        <div className="model-meta">
                          <span>{result.tokens} tokens</span>
                          <span>{money(result.cost, 6)} USDG</span>
                        </div>
                        <button className="text-button" onClick={() => setModal({ type: "receipt", data: result })}>
                          Inspect generation receipt →
                        </button>
                      </>
                    ) : (
                      <p>{busy ? (live ? "Selecting a provider and holding the worst-case cost…" : "Checking the sample route and budget…") : "Run a call to see the response and its itemized receipt."}</p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
          {tab === "Models" && (
            <ModelCatalog
              source={live ? "live" : "demo"}
              onChoose={(id) => {
                setModelId(id);
                navigate("Playground");
              }}
            />
          )}
          {tab === "API keys" && (
            <>
              <div className="panel-heading">
                <div>
                  <h2>A key for every workload.</h2>
                  <p className="help-text">{live ? "Budgeted sub-keys share this workspace’s balance. Secrets are shown once." : "Local demo keys with enforced sample budgets."}</p>
                </div>
                <Button onClick={() => setModal({ type: "key" })}>Create key</Button>
              </div>
              {live && ws?.keysError && <div className="note">This key can’t list the workspace’s other keys ({ws.keysError}).</div>}
              {view.keys.length ? (
                <div className="key-list">
                  {view.keys.map((k, i) => (
                    <article className={"key-card" + (k.active ? "" : " is-revoked")} key={k.id} style={{ "--i": i }}>
                      <div>
                        <h3>{k.name}</h3>
                        <span className={"badge " + (k.active ? "green" : "")}>{k.active ? (k.current ? "Active · this browser" : "Active") : "Revoked"}</span>
                      </div>
                      <code className="key-token">{k.token}</code>
                      <div className="budget-line">
                        <span>
                          {money(k.spent, 6)} / {k.budget == null ? "no limit" : money(k.budget, 2) + " USDG"}
                        </span>
                        <span>{k.budget == null ? "No budget limit" : Math.min(100, (k.spent / k.budget) * 100).toFixed(1) + "% used"}</span>
                      </div>
                      <progress max={k.budget ?? 1} value={k.budget == null ? 0 : Math.min(k.spent, k.budget)} aria-label={"Budget used by " + k.name} />
                      <div className="button-row">
                        <CopyButton text={live ? k.chainKeyHash : k.token} label={live ? "Copy deposit hash" : "Copy demo key"} />
                        <button className="text-button" onClick={() => setModal({ type: "key", data: k })}>
                          Edit budget
                        </button>
                        {k.active ? (
                          <button className="text-button" disabled={live && k.current} title={live && k.current ? "A key cannot revoke itself. Use Sign out, or revoke it from another management key." : undefined} onClick={() => setModal({ type: "revoke", data: k })}>
                            Revoke
                          </button>
                        ) : (
                          <button
                            className="text-button"
                            onClick={async () => {
                              if (!live) {
                                update((s) => ({ ...s, keys: s.keys.map((x) => (x.id === k.id ? { ...x, active: true } : x)) }));
                                setNotice("Demo key restored.");
                                return;
                              }
                              try {
                                await api("/api/v1/keys/" + k.id, { key: apiKey, method: "PATCH", body: { disabled: false } });
                                await refresh();
                                setNotice("Key restored.");
                              } catch (e) {
                                setError(e.message);
                              }
                            }}
                          >
                            {live ? "Restore key" : "Restore demo key"}
                          </button>
                        )}
                      </div>
                      <div className="card-ramp" />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <h3>No keys yet.</h3>
                  <p>{live ? "Create a key to start routing." : "Create a demo key to start routing."}</p>
                </div>
              )}
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
            </>
          )}
          {tab === "Receipts" && (
            <>
              <div className="panel-heading">
                <h2>Every call, accounted for.</h2>
                <Button secondary disabled={!view.receipts.length} onClick={() => downloadJSON(view.receipts, live ? "anyroute-receipts.json" : "anyroute-sample-receipts.json")}>
                  Export receipts
                </Button>
              </div>
              <div className="catalog-tools">
                <input aria-label="Search receipts" className="search-field" placeholder="Search model, provider or receipt…" value={receiptQuery} onChange={(e) => setReceiptQuery(e.target.value)} />
                <select aria-label="Filter receipts" value={receiptMode} onChange={(e) => setReceiptMode(e.target.value)}>
                  <option>All</option>
                  <option>Private</option>
                  <option>Standard</option>
                </select>
              </div>
              {filtered.length || !view.receipts.length ? (
                <ReceiptTable live={live} receipts={filtered} onInspect={(r) => setModal({ type: "receipt", data: r })} emptyAction={() => navigate("Playground")} />
              ) : (
                <div className="empty">
                  <h3>No matching receipts</h3>
                  <p>Try another search or route type.</p>
                  <Button
                    secondary
                    onClick={() => {
                      setReceiptQuery("");
                      setReceiptMode("All");
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
              {live && ws?.next && (
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      const more = await api("/api/v1/generations?limit=100&before=" + encodeURIComponent(ws.next), { key: apiKey });
                      setWs((w) => ({ ...w, receipts: [...w.receipts, ...more.data.map((g) => toReceiptRow(g, w.tokens))], next: more.next }));
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  Load older receipts →
                </button>
              )}
            </>
          )}
          {tab === "Payments" && escrowOn && (
            <>
              <div className="panel-heading">
                <h2>Pay with stock.</h2>
                <span className="badge">{"Stock escrow on " + chainOf(status).name}</span>
              </div>
              <div className="payment-balance">
                <div>
                  <span className="eyebrow">AVAILABLE CREDITS / USD</span>
                  <strong>{money(view.balance, 4)}</strong>
                  <p>{`Held for calls in progress: $${money(ws?.credits?.held ?? 0, 6)} · Credited in total: $${money(ws?.credits?.total_credits ?? 0, 2)}.`}</p>
                </div>
                <div className="button-row">
                  <Button onClick={() => setModal({ type: "stock" })}>Pay with stock</Button>
                </div>
              </div>
              <div className="panel-heading">
                <div>
                  <h2>Stock deposits</h2>
                  <p className="help-text">
                    {ws?.stock?.wallet
                      ? `Transfers from ${shortAddress(ws.stock.wallet)} to the escrow wallet, credited ${finalityWait(ws.escrow)}.`
                      : ws?.stock?.hint || "Sign in with a wallet to pay with stock."}
                  </p>
                </div>
              </div>
              <StockDeposits deposits={ws?.stock?.deposits} />
              <div className="note">
                {`Each deposit is valued with the token’s Chainlink feed on ${chainOf(status).name}${ws.escrow.haircut_bps ? `, minus ${ws.escrow.haircut_bps / 100}%` : ""}. Equity feeds pause while markets are closed; deposits made then are credited when the price updates. Tokens stay in escrow; credits are spent on API calls.`}
              </div>
            </>
          )}
          {tab === "Payments" && !escrowOn && (
            <>
              <div className="panel-heading">
                <h2>One balance. Your choice.</h2>
                <span className="badge">{live ? "USDG on " + chainOf(status).name : "Sample funds only"}</span>
              </div>
              <div className="payment-balance">
                <div>
                  <span className="eyebrow">{live ? "AVAILABLE USDG" : "AVAILABLE DEMO USDG"}</span>
                  <strong>{money(view.balance, 4)}</strong>
                  <p>{live
                      ? `Held for calls in progress: ${money(ws?.credits?.held ?? 0, 6)} · Deposited in total: ${money(ws?.credits?.total_credits ?? 0, 2)}.${ws?.credits?.pending_withdrawal ? ` Withdrawal of ${money(fromRaw(ws.credits.pending_withdrawal.amount_usdg_units, 6), 2)} pending finalization.` : " Withdraw any time."}`
                      : "No real funds or financial account."}</p>
                </div>
                <div className="button-row">
                  <Button onClick={() => setModal({ type: "credits" })}>{live ? "Deposit USDG" : "Add sample credits"}</Button>
                  {live && (
                    <Button secondary onClick={() => setModal({ type: "withdraw" })}>
                      Withdraw
                    </Button>
                  )}
                </div>
              </div>
              <div className="panel-heading">
                <div>
                  <h2>Stock Token sessions</h2>
                  <p className="help-text">{live ? "Daily caps reset at 00:00 UTC, enforced by the PayWithStock contract." : "Daily caps reset at 00:00 UTC in this preview."}</p>
                </div>
                <Button onClick={() => setModal({ type: "session" })}>Open session</Button>
              </div>
              {view.sessions.length ? (
                <div className="session-grid">
                  {view.sessions.map((s, i) => (
                    <article className="route-card session-card" key={s.id} style={{ "--i": i }}>
                      <span className="eyebrow">{live ? "CAPPED SESSION · " + shortAddress(s.wallet) : "CAPPED SAMPLE SESSION"}</span>
                      <h3>{s.token}</h3>
                      <span className={"badge " + (s.active ? "green" : "")}>{live && !s.open ? "Closed" : s.active ? "Active" : "Paused"}</span>
                      <dl className="detail-list">
                        <div>
                          <dt>Daily cap</dt>
                          <dd>{s.cap} units</dd>
                        </div>
                        <div>
                          <dt>Spent today</dt>
                          <dd>{(live || s.day === new Date().toISOString().slice(0, 10) ? s.spent : 0).toFixed(10)} units</dd>
                        </div>
                        {live && (
                          <div>
                            <dt>Accrued, not swapped</dt>
                            <dd>{money(s.debt ?? 0, 6)} USDG</dd>
                          </div>
                        )}
                      </dl>
                      <div className="button-row">
                        <button className="text-button" onClick={() => setModal({ type: "session", data: s })}>
                          Edit cap
                        </button>
                        <button className="text-button" disabled={live && !s.open} onClick={() => toggleSession(s)}>
                          {s.active ? "Pause" : "Resume"}
                        </button>
                        <button className="text-button" disabled={live && !s.open} onClick={() => setModal({ type: "close-session", data: s })}>
                          Close
                        </button>
                      </div>
                      <div className="card-ramp" />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <h3>No sessions open.</h3>
                  <p>{live ? "Open a capped session to pay for calls with a Stock Token." : "Create a capped sample session to try paying with a Stock Token."}</p>
                  <Button secondary onClick={() => setModal({ type: "session" })}>
                    {live ? "Open session" : "Open sample session"}
                  </Button>
                </div>
              )}
              <div className="note">
                {live
                  ? `Fair value comes from the token’s Chainlink feed on ${chainOf(status).name} (it already includes the token’s multiplier). Swaps are exact-output, slippage-bounded and never exceed your daily cap. Pausing keeps the session open but stops using it by default.`
                  : "Conversion fixtures: NVDA = 100 USDG; TSLA = 200 USDG. These are fictional demo values, not market quotes. No wallet authorization, swap, transfer or settlement occurs."}
              </div>
              <div className="panel-heading">
                <h2>Payment statement</h2>
                <Button
                  secondary
                  disabled={!view.receipts.length}
                  onClick={async () => {
                    if (!live) return downloadJSON(state.receipts.map(({ id, time, paidWith, units, cost }) => ({ id, time, paidWith, units, cost })), "anyroute-sample-statement.json");
                    try {
                      const month = new Date().toISOString().slice(0, 7);
                      downloadJSON((await api("/api/v1/paywith/statement?month=" + month, { key: apiKey })).data, "anyroute-statement-" + month + ".json");
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  Export statement
                </Button>
              </div>
              <ReceiptTable
                live={live}
                receipts={view.receipts.filter((r) => !String(r.paidWith).startsWith("USDG"))}
                onInspect={(r) => setModal({ type: "receipt", data: r })}
                emptyTitle="No Stock Token payments yet."
                emptyText={live ? "Calls paid with a Stock Token appear here with their token allocation." : "Sample calls paid with NVDA or TSLA appear here with their sample token allocation."}
              />
            </>
          )}
          {tab === "Providers" && (
            <>
              <div className="panel-heading">
                <h2>Know who serves the call.</h2>
                <span className="badge">{live ? "Live provider registry" : "Fictional providers"}</span>
              </div>
              <p className="catalog-note">
                {live
                  ? "Uptime is the 30-day share of successful calls and probes; latency is time to first token (p50). Bonds are read from the ProviderBond contract; attestation is re-verified every 10 minutes."
                  : "Names, health, bonds and attestation states are illustrative fixtures. No provider partnership is implied."}
              </p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th className="num">{live ? "Uptime (30d)" : "Uptime fixture"}</th>
                      <th className="num">{live ? "Latency (p50)" : "Latency fixture"}</th>
                      <th className="num">{live ? "Bond" : "Bond fixture"}</th>
                      <th>Private route</th>
                      <th>
                        <span className="sr-only">Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerRows.map((p, i) => (
                      <tr key={p.name} style={{ "--i": i }}>
                        <td className="cell-primary">
                          <strong>{p.name}</strong>
                          <small>{p.quant}</small>
                        </td>
                        <td className="num" data-label={live ? "Uptime (30d)" : "Uptime fixture"}>
                          {p.uptime == null ? "No data yet" : p.uptime + "%"}
                        </td>
                        <td className="num" data-label={live ? "Latency (p50)" : "Latency fixture"}>
                          {p.latency == null ? "No data yet" : Math.round(p.latency) + " ms"}
                        </td>
                        <td className="num" data-label={live ? "Bond" : "Bond fixture"}>
                          {p.bond ? p.bond.toLocaleString() + " USDG" : live ? "Operator-onboarded" : "0 USDG"}
                        </td>
                        <td data-label="Private route">
                          <span className={"route-tag" + (p.private ? " private" : " off")}>{p.private ? (live ? "Attested TEE" : "TEE fixture") : "Unavailable"}</span>
                        </td>
                        <td className="cell-action">
                          <button className="text-button" onClick={() => setModal({ type: "provider", data: p })}>
                            Details →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {live && !providerRows.length && <div className="empty">{liveProviders ? "No live providers yet." : "Loading providers…"}</div>}
              <div className="note">
                {live
                  ? "Self-serve providers apply with the provider spec, post a 10,000 USDG bond and pass a 7-day canary shadow period before they receive live traffic."
                  : "Production onboarding is planned to include schema validation, a USDG bond and a canary shadow period before a provider is routed live."}
              </div>
            </>
          )}
          {tab === "Settings" && (
            <>
              <div className="panel-heading">
                <h2>{live ? "Your workspace." : "Your sample workspace."}</h2>
              </div>
              <div className="settings-grid">
                <div className="settings-panel">
                  <h3>{live ? "This browser" : "Browser-local data"}</h3>
                  <p>
                    {live
                      ? `Signed in with ${ws?.me?.label ?? "—"}. The key is kept in this browser (this tab session only). The router stores key hashes, balances and receipt metadata — never prompts or responses. The export contains your keys (no secrets), balance and receipts.`
                      : "Changes persist only in this browser. No account has been created. The workspace export contains demo keys, receipt metadata, sessions and sample balances; it contains no prompt text."}
                  </p>
                  <div className="button-row">
                    <Button
                      secondary
                      onClick={() =>
                        live ? downloadJSON({ exported_at: new Date().toISOString(), key: ws?.me, keys: ws?.keys, credits: ws?.credits, session: ws?.session, receipts: ws?.receipts }, "anyroute-workspace.json") : downloadJSON(state, "anyroute-sample-workspace.json")
                      }
                    >
                      Export workspace
                    </Button>
                    <Button secondary onClick={() => setModal({ type: "reset" })}>
                      {live ? "Sign out of this browser" : "Reset sample workspace"}
                    </Button>
                  </div>
                </div>
                <div className="settings-panel">
                  <h3>{live ? "Connect your app" : "Production integration"}</h3>
                  <p>
                    {live
                      ? `Point any OpenAI- or OpenRouter-compatible client at ${origin}/api/v1 and use this key (or a budgeted sub-key). Requests, streaming, provider preferences and usage fields work unchanged.`
                      : "Authentication, server storage, inference, payments and verified receipts need backend services. This preview never treats a connected wallet as a payment or entitlement."}
                  </p>
                  <div className="button-row">
                    <Button href="/docs/">Read the docs</Button>
                    {live ? (
                      <>
                        <CopyButton text={origin + "/api/v1"} label="Copy base URL" />
                        <button className="text-button" onClick={() => switchMode("demo")}>
                          Open the sample workspace
                        </button>
                      </>
                    ) : (
                      <button className="text-button" onClick={() => switchMode("live")}>
                        Connect to the live API
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      </section>
      {modal?.type === "receipt" && <ReceiptDetails receipt={modal.data} apiKey={apiKey} status={status} onClose={() => setModal(null)} />}
      {modal?.type === "key" && <KeyDialog live={live} existing={modal.data} onClose={() => setModal(null)} onSave={saveKeyValues} />}
      {modal?.type === "session" && <SessionDialog live={live} tokens={ws?.tokens || []} paywith={ws?.paywith || {}} existing={modal.data} onClose={() => setModal(null)} onSave={saveSession} />}
      {modal?.type === "provider" && (
        <Modal title={modal.data.name} onClose={() => setModal(null)}>
          <span className="badge">{live ? "Provider record · " + modal.data.status : "Fictional provider record"}</span>
          <dl className="detail-list">
            <div>
              <dt>Quantization</dt>
              <dd>{modal.data.quant}</dd>
            </div>
            <div>
              <dt>{live ? "Attestation" : "Attestation fixture"}</dt>
              <dd>{live ? (modal.data.private ? `${modal.data.tee?.toUpperCase() || "TEE"} · ${modal.data.attestation?.slice(0, 22)}… · ${new Date(modal.data.attestedAt).toLocaleString("en-GB")}` : "Not attested") : modal.data.private ? "TEE example — not verified" : "Unavailable"}</dd>
            </div>
            <div>
              <dt>{live ? "Data policy" : "Data policy fixture"}</dt>
              <dd>
                {live
                  ? `${modal.data.policy.training ? "May train on data" : "No training"} · ${modal.data.policy.retains_prompts ? "Retains prompts" : "Does not retain prompts"}${modal.data.policy.zdr ? " · Zero data retention" : ""}`
                  : "Model requests are not sent in this preview."}
              </dd>
            </div>
            <div>
              <dt>{live ? "Bond" : "Bond fixture"}</dt>
              <dd>{modal.data.bond} USDG</dd>
            </div>
            {live && (
              <div>
                <dt>Models served</dt>
                <dd>{modal.data.models}</dd>
              </div>
            )}
          </dl>
          <p className="note">{live ? "Health comes from routed traffic and 15-second probes; a provider with two failures in 30 seconds is skipped until it recovers." : "A production record must show verified provider terms, health provenance, bond contract and attestation evidence."}</p>
          <Button href="/docs/#routing">Routing documentation</Button>
        </Modal>
      )}
      {modal?.type === "credits" &&
        (live ? (
          <DepositDialog
            apiKey={apiKey}
            credits={ws?.credits}
            status={status}
            onClose={() => setModal(null)}
            onDone={async (amount, kind) => {
              const before = ws?.credits?.total_credits ?? 0;
              for (let i = 0; i < 30; i++) {
                const next = await refresh();
                if ((next.credits?.total_credits ?? 0) >= before + amount - 1e-9) break;
                await new Promise((r) => setTimeout(r, 1000));
              }
              setNotice(kind === "test" ? amount + " test USDG added." : amount + " USDG deposited.");
              if (errorKind === "insufficient_credits") {
                setError("");
                setErrorKind("");
              }
              setModal(null);
            }}
          />
        ) : (
          <Modal title="Add sample credits" onClose={() => setModal(null)}>
            <p>Add 25 USDG to this browser’s demo balance. This is a free local simulation, with no deposit, purchase or transfer.</p>
            <div className="button-row modal-actions">
              <Button
                onClick={() => {
                  update((s) => ({ ...s, balance: s.balance + 25 }));
                  setNotice("25 sample USDG added. No real funds were transferred.");
                  setModal(null);
                }}
              >
                Add 25 sample USDG
              </Button>
              <Button secondary onClick={() => setModal(null)}>
                Cancel
              </Button>
            </div>
          </Modal>
        ))}
      {modal?.type === "stock" && (
        <StockDepositDialog
          escrow={ws?.escrow}
          stock={ws?.stock}
          status={status}
          onClose={() => setModal(null)}
          onDone={async () => {
            // The transfer shows up within seconds as "Waiting for finality"; the credit follows once
            // the chain finalizes it, so wait only until the router has seen it.
            const before = (ws?.stock?.deposits || []).length;
            let next = ws;
            for (let i = 0; i < 45; i++) {
              next = await refresh();
              if ((next.stock?.deposits || []).length > before) break;
              await new Promise((r) => setTimeout(r, 2000));
            }
            const seen = (next.stock?.deposits || []).length > before;
            setNotice(seen ? `Stock deposit received. It is credited ${finalityWait(next.escrow)}; track it under Stock deposits.` : "Stock deposit sent. It appears under Stock deposits once the router sees it.");
            if (errorKind === "insufficient_credits") {
              setError("");
              setErrorKind("");
            }
            setModal(null);
          }}
        />
      )}
      {modal?.type === "withdraw" && <WithdrawDialog apiKey={apiKey} credits={ws?.credits} status={status} onClose={() => setModal(null)} onDone={() => refresh()} />}
      {["reset", "revoke", "close-session"].includes(modal?.type) && (
        <Modal
          title={modal.type === "reset" ? (live ? "Sign out of this browser?" : "Reset the sample workspace?") : modal.type === "revoke" ? (live ? "Revoke this key?" : "Revoke this demo key?") : live ? "Close this session?" : "Close this sample session?"}
          onClose={() => setModal(null)}
        >
          <p>
            {modal.type === "reset"
              ? live
                ? "This forgets the key in this browser. Your key, balance and receipts stay with the router; connect the key again any time."
                : "This removes the current browser’s sample records and restores 25 demo USDG and the starter key. Export the workspace first if you want to keep a copy."
              : modal.type === "revoke"
                ? live
                  ? "This key stops working immediately. Existing receipts remain, and you can restore it later from a management key."
                  : "This key will stop working in the local playground. Existing receipts remain. You can restore the demo key later."
                : live
                  ? "Your wallet sends closeSession to the PayWithStock contract. It takes effect immediately; accrued debt is still settled."
                  : "This sample token session will be removed. Existing generation receipts remain."}
          </p>
          <div className="button-row modal-actions">
            <Button
              onClick={async () => {
                try {
                  await confirmAction();
                } catch (e) {
                  setError(e?.message || String(e));
                  setModal(null);
                }
              }}
            >
              {modal.type === "reset" ? (live ? "Sign out" : "Reset workspace") : modal.type === "revoke" ? (live ? "Revoke key" : "Revoke demo key") : "Close session"}
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {reveal && <SecretDialog secret={reveal.secret} deposit={reveal.deposit} title={reveal.title} onClose={() => setReveal(null)} />}
    </main>
  );
}
