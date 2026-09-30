#!/usr/bin/env node
// Verify an Anyroute organisation audit export offline, with nothing but Node (or Bun) and this file.
//
//   node scripts/verify-audit.mjs anyroute-audit-<team>.jsonl [--head <hex>]
//   node scripts/verify-audit.mjs anyroute-audit-<team>.csv   [--head <hex>]
//
// Checks, from the first entry: seq counts up by one; each prev_hash is the previous entry's hash (64 zeros first);
// each hash = sha256(bytes(prev_hash) || utf8(canonical_json({team, seq, at, actor, action, target, detail}))) where
// canonical JSON sorts object keys recursively. For JSONL it also checks the header's count and head, and recomputes every
// hourly RFC 6962 Merkle root. --head pins the head hash you saw earlier (for example in the dashboard): a log that was
// rewritten or cut short no longer ends there. It deliberately shares no code with the router.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const GENESIS = "0".repeat(64);

export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

export function entryHash(prevHash, e) {
  const body = JSON.stringify(canonical({ team: e.team, seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail }));
  return createHash("sha256").update(Buffer.from(prevHash, "hex")).update(Buffer.from(body, "utf8")).digest("hex");
}

const H = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** RFC 6962 Merkle tree hash over raw leaves (here: 32-byte entry hashes). */
export function merkleRoot(leaves) {
  if (leaves.length === 0) return H();
  if (leaves.length === 1) return H(Buffer.of(0), leaves[0]);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return H(Buffer.of(1), merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

export function hourlyRoots(entries) {
  const out = [];
  for (const e of entries) {
    const hour = e.at.slice(0, 13) + ":00:00Z";
    const last = out.at(-1);
    if (last && last.hour === hour) {
      last.leaves.push(Buffer.from(e.hash, "hex"));
      last.last_seq = e.seq;
    } else out.push({ hour, first_seq: e.seq, last_seq: e.seq, leaves: [Buffer.from(e.hash, "hex")] });
  }
  return out.map((r) => ({ hour: r.hour, first_seq: r.first_seq, last_seq: r.last_seq, count: r.leaves.length, root: merkleRoot(r.leaves).toString("hex") }));
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows;
}

export function parseExport(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    const items = lines.map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`line ${i + 1} is not JSON`);
      }
    });
    return {
      format: "jsonl",
      header: items.find((x) => x.type === "header") ?? null,
      entries: items.filter((x) => x.type === "entry"),
      roots: items.filter((x) => x.type === "root"),
    };
  }
  const [head, ...rows] = parseCsv(text).filter((r) => r.length > 1 || r[0] !== "");
  const want = ["team", "seq", "at", "actor", "action", "target", "detail", "prev_hash", "hash"];
  if (!head || want.some((c, i) => head[i] !== c)) throw new Error(`CSV header must be ${want.join(",")}`);
  const entries = rows.map((r) => ({ team: r[0], seq: Number(r[1]), at: r[2], actor: r[3], action: r[4], target: r[5], detail: JSON.parse(r[6]), prev_hash: r[7], hash: r[8] }));
  return { format: "csv", header: null, entries, roots: [] };
}

/** Verify an export's text. Returns { ok, entries, head, roots } or { ok: false, error, seq? }. */
export function verifyExport(text, { head: pinned } = {}) {
  let parsed;
  try {
    parsed = parseExport(text);
  } catch (e) {
    return { ok: false, error: String(e.message ?? e) };
  }
  const { header, entries, roots } = parsed;
  const genesis = header?.genesis ?? GENESIS;
  if (genesis !== GENESIS) return { ok: false, error: "unknown genesis" };
  let prev = GENESIS;
  const team = header?.team ?? entries[0]?.team;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, seq: e.seq, error: `entry ${i + 1} has seq ${e.seq}: an entry is missing, added or out of order` };
    if (e.team !== team) return { ok: false, seq: e.seq, error: "entry belongs to another team" };
    if (e.prev_hash !== prev) return { ok: false, seq: e.seq, error: "prev_hash does not match the previous entry's hash" };
    if (entryHash(prev, e) !== e.hash) return { ok: false, seq: e.seq, error: "hash does not match the entry's contents" };
    prev = e.hash;
  }
  if (header) {
    if (header.entries !== entries.length) return { ok: false, error: `header says ${header.entries} entries, the file has ${entries.length}` };
    if (header.head !== prev) return { ok: false, error: "header head is not the last entry's hash" };
    const expected = hourlyRoots(entries);
    if (roots.length !== expected.length) return { ok: false, error: `expected ${expected.length} hourly roots, found ${roots.length}` };
    for (let i = 0; i < expected.length; i++) {
      const r = roots[i];
      const x = expected[i];
      if (r.hour !== x.hour || r.first_seq !== x.first_seq || r.last_seq !== x.last_seq || r.count !== x.count || r.root !== x.root) return { ok: false, error: `hourly root for ${x.hour} does not match` };
    }
  }
  if (pinned && pinned.toLowerCase() !== prev) return { ok: false, error: `the chain ends at ${prev}, not at the pinned head ${pinned}` };
  return { ok: true, team, entries: entries.length, head: prev, roots: header ? roots.length : hourlyRoots(entries).length };
}

const isMain = (() => {
  try {
    return import.meta.main ?? (process.argv[1] && new URL(import.meta.url).pathname === (process.argv[1].startsWith("/") ? process.argv[1] : `${process.cwd()}/${process.argv[1]}`));
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const at = args.indexOf("--head");
  if (!file) {
    console.error("usage: node scripts/verify-audit.mjs <export.jsonl|export.csv> [--head <hex>]");
    process.exit(2);
  }
  const r = verifyExport(readFileSync(file, "utf8"), { head: at >= 0 ? args[at + 1] : undefined });
  if (r.ok) console.log(`OK  team ${r.team ?? "(empty)"}  ${r.entries} entries  ${r.roots} hourly roots  head ${r.head}`);
  else console.error(`FAILED${r.seq ? ` at seq ${r.seq}` : ""}: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
