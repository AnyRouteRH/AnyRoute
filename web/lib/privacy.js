// The verify page's "What we saw" panel: looking a receipt up by id and turning the router's label into rows.
// The label itself is computed by the router (GET /api/v1/receipts/{id}/privacy) from the signed receipt and by
// @anyroute/client's privacyLabel; this file only fetches it, checks its shape and lays it out. It adds no claim of
// its own: every sentence shown is one the label carries.

const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Receipt ids are plain tokens; anything else is not looked up. */
export const isReceiptId = (id) => RECEIPT_ID.test(String(id ?? ""));
export const privacyPath = (receiptId) => `/api/v1/receipts/${encodeURIComponent(receiptId)}/privacy`;

/** The receipt id from `?r=` (or `?receipt=`), or "" when absent or not a plausible id. */
export function receiptIdFromSearch(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const id = (params.get("r") || params.get("receipt") || "").trim();
  return isReceiptId(id) ? id : "";
}
export const privacyHref = (receiptId) => `/verify/?r=${encodeURIComponent(receiptId)}`;

const FACETS = [
  ["output", "Output and usage"],
  ["prompt_readers", "Who could read the request"],
  ["network", "Who saw your address"],
  ["payment", "How it was paid"],
  ["stored", "What was kept"],
  ["hardware", "What hardware answered"],
];
const LANES = { public: "Public lane", attested: "Attested lane", unlinkable: "Unlinkable lane" };
const text = (v, max = 1600) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * The label as the page shows it, or null when the response is not a label. `doc` is the endpoint's `data`
 * (a bare label is accepted too). Missing pieces are left out, never filled in.
 */
export function describePrivacy(doc) {
  const d = doc && typeof doc === "object" && doc.data && typeof doc.data === "object" ? doc.data : doc;
  if (!d || typeof d !== "object" || !Array.isArray(d.summary) || !d.label || typeof d.label !== "object") return null;
  const summary = d.summary.filter((s) => typeof s === "string" && s).map((s) => s.slice(0, 400)).slice(0, 5);
  if (!summary.length) return null;
  const rows = FACETS.map(([key, title]) => ({ key, title, text: text(d.label[key]?.text) })).filter((r) => r.text);
  return {
    id: isReceiptId(d.receipt_id) ? d.receipt_id : "",
    lane: LANES[d.lane] || "Lane not recorded in this receipt",
    summary,
    rows,
    short: text(d.short, 400),
  };
}
