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
