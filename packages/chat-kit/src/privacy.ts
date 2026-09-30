// Privacy labels: GET /api/v1/receipts/{id}/privacy, computed by the router from the signed receipt. This file only
// fetches the label, checks its shape and lays it out. It adds no claim of its own: every line shown is one the label
// carries, and a field the router did not send is left out.

import { getJson, type ClientOptions } from "./client";
import type { PrivacyLabelData } from "./types";

const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Receipt ids are plain tokens; anything else is never looked up or linked. */
export const isReceiptId = (id: unknown): id is string => RECEIPT_ID.test(String(id ?? ""));
export const privacyPath = (id: string) => `/api/v1/receipts/${encodeURIComponent(id)}/privacy`;

export const LABEL_FIELDS: [string, string][] = [
  ["output", "Output and usage"],
  ["prompt_readers", "Who could read the prompt"],
  ["network", "Who saw your address"],
  ["payment", "How it was paid"],
  ["stored", "What was kept"],
  ["hardware", "What hardware answered"],
];

const clean = (v: unknown, max: number) =>
  String(v)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const words = (v: string) => (/^[a-z][a-z0-9]*([_-][a-z0-9]+)+$/.test(v) ? v.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase()) : v);

/** One label value as a short line: a string, a list of strings, or an object with a text-like field. */
export function labelText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return words(clean(value, 200));
  if (Array.isArray(value)) return clean(value.filter((x) => typeof x === "string").map((x) => words(clean(x, 80))).join(", "), 200);
  if (typeof value === "object") {
    for (const k of ["text", "summary", "label", "value", "description"]) {
      const v = (value as Record<string, unknown>)[k];
      if (typeof v === "string") return clean(v, 200);
    }
  }
  return "";
}

/** A link from the router that is safe to render: a site path or an http(s) URL. */
export function safeUrl(value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (/^\/(?![/\\])/.test(v)) return v;
  return /^https?:\/\/[^\s]+$/i.test(v) ? v : "";
}

/** The label from the privacy endpoint (bare or inside { data }), or null when the body is not one. */
export function normalizeLabel(body: unknown): PrivacyLabelData | null {
  const b = body as { data?: unknown };
  const doc = (b && typeof b === "object" && b.data && typeof b.data === "object" ? b.data : body) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || !doc.label || typeof doc.label !== "object") return null;
  const label = doc.label as Record<string, unknown>;
  const rows = LABEL_FIELDS.map(([key, title]) => ({ key, title, text: labelText(label[key]) })).filter((r) => r.text);
  const summary = (Array.isArray(doc.summary) ? doc.summary : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => clean(x, 240))
    .filter(Boolean)
    .slice(0, 5);
  if (!rows.length && !summary.length) return null;
  return {
    receiptId: isReceiptId(doc.receipt_id) ? doc.receipt_id : "",
    lane: typeof doc.lane === "string" ? clean(doc.lane, 32) : "",
    rows,
    summary,
    verifyUrl: safeUrl(doc.verify_url),
  };
}

/** One reply's label. Never throws: { label: null, reason } when absent (404/405/501), refused or unreachable. */
export async function fetchPrivacyLabel(opts: ClientOptions, receiptId: string, signal?: AbortSignal): Promise<{ label: PrivacyLabelData | null; reason: "" | "absent" | "unavailable" }> {
  if (!isReceiptId(receiptId)) return { label: null, reason: "absent" };
  try {
    return { label: normalizeLabel(await getJson(opts, privacyPath(receiptId), signal)), reason: "" };
  } catch (e) {
    const status = Number((e as { status?: number })?.status) || 0;
    return { label: null, reason: status === 404 || status === 405 || status === 501 ? "absent" : "unavailable" };
  }
}

/** Where a receipt is shown and checked: `${verifyBase}/verify/?r=<id>`. */
export const receiptHref = (receiptId: string, verifyBase = "") => `${String(verifyBase).replace(/\/+$/, "")}/verify/?r=${encodeURIComponent(receiptId)}`;
