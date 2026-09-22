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
