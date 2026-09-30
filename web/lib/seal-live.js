// What this router reports about itself in GET /api/v1/status, read when the page opens. Only fields the router
// returns are shown; a field it does not return reads "not reported", and a feature it reports off reads
// "not switched on here".
const OFF = "Not switched on here";
const ONION = /^[a-z2-7]{56}\.onion$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const VIA = { ohttp: "Oblivious HTTP relay", onion: "Tor onion service" };

const every = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const h = ms / 3_600_000;
  if (Number.isInteger(h)) return h === 1 ? "Every hour" : `Every ${h} hours`;
  const m = ms / 60_000;
  return Number.isInteger(m) ? `Every ${m} minutes` : `Every ${Math.round(ms / 1000)} seconds`;
};

function laneRow(name, lane) {
  if (!lane || typeof lane !== "object" || typeof lane.available !== "boolean") return { name, value: "Not reported", state: "unknown" };
  if (!lane.available) return { name, value: OFF, state: "off" };
  const models = Number.isFinite(lane.models) ? `${lane.models.toLocaleString("en-US")} model${lane.models === 1 ? "" : "s"}` : "";
  // The transports that carry the lane, where the router says (lanes.unlinkable.via); names it does not send are not shown.
  const via = Array.isArray(lane.via) ? lane.via.map((t) => VIA[t]).filter(Boolean) : [];
  return { name, value: `Available${models ? ` · ${models}` : ""}${via.length ? ` · via ${via.join(" or ")}` : ""}`, state: "on" };
}

/** Rows for the /seal page's live panel from the data object of GET /api/v1/status. */
export function liveRows(data) {
  const d = data && typeof data === "object" ? data : {};
  const lanes = d.lanes && typeof d.lanes === "object" ? d.lanes : null;
  const rows = [laneRow("Public lane", lanes?.public), laneRow("Attested lane", lanes?.attested), laneRow("Unlinkable lane", lanes?.unlinkable)];
  const onion = d.onion?.address;
  rows.push(ONION.test(onion || "") ? { name: "Onion service", value: onion, state: "on", mono: true } : { name: "Onion service", value: "onion" in d ? OFF : "Not reported", state: "onion" in d ? "off" : "unknown" });
  const keyId = d.receipts?.key_id;
  rows.push(typeof keyId === "string" && keyId ? { name: "Receipt signing key", value: keyId, state: "on", mono: true } : { name: "Receipt signing key", value: "Not reported", state: "unknown" });
  const contracts = d.chain?.contracts && typeof d.chain.contracts === "object" ? d.chain.contracts : null;
  const interval = every(d.receipts?.anchor_interval_ms);
  // Roots are built on this interval; they go on chain only where a ReceiptAnchor contract is configured.
  const anchored = !contracts ? "" : ADDRESS.test(contracts.receiptAnchor || "") ? "; anchor contract configured" : "; posting on chain not switched on here";
  rows.push(interval ? { name: "Receipt roots", value: interval + anchored, state: "on" } : { name: "Receipt roots", value: "Not reported", state: "unknown" });
  if (contracts) {
    const set = Object.entries(contracts).filter(([, v]) => typeof v === "string" && ADDRESS.test(v));
    const explorer = typeof d.chain?.explorer === "string" && /^https:\/\//.test(d.chain.explorer) ? d.chain.explorer.replace(/\/$/, "") : null;
    rows.push(set.length ? { name: "Chain contracts", contracts: set.map(([name, address]) => ({ name, address, href: explorer ? `${explorer}/address/${address}` : null })), state: "on" } : { name: "Chain contracts", value: OFF, state: "off" });
  } else rows.push({ name: "Chain contracts", value: "Not reported", state: "unknown" });
  return rows;
}
