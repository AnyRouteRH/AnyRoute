// Teams tab helpers: pure functions shared by components/features/Teams.jsx and tests/teams.test.mjs.
// An organisation (team) is anonymous: members join with a passkey (WebAuthn) or a wallet signature, never an email or a
// password. Its audit log is a hash chain the browser can recompute with WebCrypto:
//   h_0 = 64 zeros,  h_i = sha256( bytes(h_{i-1}) || utf8(canonical({team, seq, at, actor, action, target, detail})) )
// and hourly RFC 6962 Merkle roots over the raw 32-byte entry hashes. The router is the authority on every rule; these
// helpers only format, convert and re-check what it returns.

// ---------- roles ----------

export const ROLES = ["owner", "admin", "dev", "viewer", "agent"];
const RANK = { agent: 0, viewer: 1, dev: 2, admin: 3, owner: 4 };

export const ROLE_INFO = {
  owner: { label: "Owner", summary: "Everything, and binds the owner wallet or Safe.", can: ["Bind the owner wallet or Safe", "Invite admins and change any role", "Everything an admin can do"] },
  admin: { label: "Admin", summary: "Manages members, keys and the budget.", can: ["Invite developers and viewers, change their roles, revoke them", "Create and limit keys", "Set the organisation budget"] },
  dev: { label: "Developer", summary: "Builds with keys inside the budget.", can: ["Create keys in the organisation within its budget", "Use keys", "Read the team, usage and the audit log"] },
  viewer: { label: "Viewer", summary: "Reads, changes nothing.", can: ["Read the team, usage, receipts and the audit log"] },
  agent: { label: "Agent", summary: "Calls models, sees nothing else.", can: ["API calls only: chat, embeddings, batches", "No organisation routes (403)"] },
};

/** The legacy role "member" is a developer; anything unknown is null. */
export const normalizeRole = (role) => (role === "member" ? "dev" : ROLES.includes(role) ? role : null);
export const roleRank = (role) => RANK[normalizeRole(role)] ?? -1;
export const roleLabel = (role) => ROLE_INFO[normalizeRole(role)]?.label ?? String(role || "Unknown");
export const roleCan = (role) => ROLE_INFO[normalizeRole(role)]?.can ?? [];
/** True when `role` is `min` or above. An agent is below every organisation role. */
export const atLeast = (role, min) => roleRank(role) >= 0 && roleRank(role) >= roleRank(min);

/**
 * The router's rule for handing out roles: the owner (or a management key, which acts as owner) may change anything; an
 * admin only keys and members below its own role. Everyone else changes nothing.
 */
export const canManage = (yourRole, targetRole) => normalizeRole(yourRole) === "owner" || (normalizeRole(yourRole) === "admin" && roleRank(targetRole) < roleRank("admin"));
/** Roles a key in the organisation can be given with PUT /members/:hash: an owner any, an admin only those below its own. */
export function assignableRoles(yourRole) {
  if (normalizeRole(yourRole) === "owner") return [...ROLES];
  if (normalizeRole(yourRole) === "admin") return ["dev", "viewer", "agent"];
  return [];
}
/** Roles an invite, or a passkey or wallet member, can carry. Agents are API keys, never invited people. */
export function inviteRoles(yourRole) {
  if (normalizeRole(yourRole) === "owner") return ["admin", "dev", "viewer"];
  if (normalizeRole(yourRole) === "admin") return ["dev", "viewer"];
  return [];
}
/** Roles a new API key in the organisation can take (POST /api/v1/keys with role): never above the creator's own. */
export function keyRoles(yourRole) {
  if (atLeast(yourRole, "admin")) return ["admin", "dev", "viewer", "agent"];
  if (atLeast(yourRole, "dev")) return ["dev", "viewer", "agent"];
  return [];
}

export const INVITE_METHODS = [
  ["any", "Passkey or wallet"],
  ["passkey", "Passkey only"],
  ["wallet", "Wallet only"],
];
export const TTL = { min: 1, max: 168, default: 72 };
export const INVITE_RE = /^ar-inv-[0-9a-f]{48}$/;
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2})+$/;

/** An invite code from what was pasted: the code itself or a join link that carries it. */
export function extractInvite(text) {
  const m = String(text || "").match(/ar-inv-[0-9a-f]{48}/);
  return m ? m[0] : "";
}
export const joinLink = (invite, origin = "") => `${origin}/dashboard/?join=${encodeURIComponent(invite)}#teams`;

/** Validate the invite form. Returns an error message, or "" when it can be sent. */
export function validateInvite({ role, method, ttl }, yourRole) {
  if (!inviteRoles(yourRole).includes(role)) return "Choose a role you are allowed to give.";
  if (!INVITE_METHODS.some(([m]) => m === method)) return "Choose how the member signs in.";
  const n = Number(ttl);
  if (!Number.isInteger(n) || n < TTL.min || n > TTL.max) return `The invite lasts 1 to ${TTL.max} hours.`;
  return "";
}

/** A budget field: "" means no budget (null); otherwise a non-negative USD amount. Returns { ok, value } or { ok: false, error }. */
export function parseBudget(text) {
  const s = String(text ?? "").trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Enter a USD amount of 0 or more, or leave it empty for no budget." };
  return { ok: true, value: Math.round(n * 1e6) / 1e6 };
}

export const formatUsd = (n) => (n == null ? "No budget" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Number(n) !== 0 && Math.abs(n) < 0.01 ? 6 : 2 }));
/** Share of the budget already given to keys, 0 to 100, or null without a budget. */
export const budgetShare = (team) => (team?.budget_usd > 0 ? Math.min(100, (100 * (team.allocated_usd || 0)) / team.budget_usd) : team?.budget_usd === 0 ? 100 : null);
export const shortHex = (hex, n = 12) => (hex ? String(hex).slice(0, n) : "");
export const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "");

export const OWNER_KIND = { account: "The owning account", eoa: "Wallet (EOA)", contract: "Smart account (Safe or other EIP-1271 contract)" };

// ---------- actors and actions in the audit log ----------

export function parseActor(actor) {
  const s = String(actor || "");
  const i = s.indexOf(":");
  return i < 0 ? { kind: "unknown", id: s } : { kind: s.slice(0, i), id: s.slice(i + 1) };
}

/** "key:<16 hex>" -> "Key 1a2b…", "passkey:tp_…" -> "Passkey tp_…", "wallet:0x…" -> "Wallet 0x1234…abcd". */
export function actorLabel(actor) {
  const { kind, id } = parseActor(actor);
  if (kind === "key") return "Key " + id;
  if (kind === "passkey") return "Passkey " + id;
  if (kind === "wallet") return "Wallet " + shortAddr(id);
  return String(actor || "Unknown");
}

const ACTIONS = {
  "team.create": "Organisation created",
  "team.rename": "Renamed",
  "budget.set": "Budget set",
  "owner.bind": "Owner bound",
  "invite.create": "Invite created",
  "member.join": "Member joined",
  "member.role": "Role changed",
  "member.revoke": "Member revoked",
  "member.restore": "Member restored",
  "key.create": "Key created",
  "key.update": "Key updated",
  "key.disable": "Key disabled",
  "preset.save": "Preset saved",
  "preset.rollback": "Preset rolled back",
  "preset.delete": "Preset deleted",
  "route.create": "Route created",
  "route.update": "Route updated",
  "route.delete": "Route deleted",
  "playbook.create": "Playbook created", // U115
  "playbook.update": "Playbook changed",
  "playbook.rename": "Playbook renamed",
  "playbook.delete": "Playbook deleted",
  "playbook.follow": "Key follows a playbook",
  "playbook.unfollow": "Key stopped following a playbook",
};
export const AUDIT_ACTIONS = Object.keys(ACTIONS);
export const actionLabel = (action) => ACTIONS[action] ?? String(action || "Unknown");

/** An entry's detail as one short line: "role: dev · method: passkey". */
export function detailText(detail) {
  if (!detail || typeof detail !== "object") return "";
  return Object.keys(detail)
    .sort()
    .filter((k) => detail[k] !== undefined)
    .map((k) => `${k}: ${Array.isArray(detail[k]) ? detail[k].join(", ") : detail[k] === null ? "none" : typeof detail[k] === "object" ? JSON.stringify(detail[k]) : detail[k]}`)
    .join(" · ");
}

/** Newest-first paging over a contiguous chain of `total` entries: the ?after= and ?limit= of page `page` (0 = newest). */
export function auditPage(total, page, size) {
  const end = Math.max(0, total - page * size);
  const after = Math.max(0, end - size);
  return { after, limit: end - after };
}
export const pageCount = (total, size) => Math.max(1, Math.ceil(total / size));

// ---------- base64url and WebAuthn ----------

const asBytes = (input) => (input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(0));

export function bytesToB64url(input) {
  const bytes = asBytes(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(text) {
  const s = String(text ?? "").replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("Not a base64url string.");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** An exactly sized ArrayBuffer, which is what navigator.credentials expects for binary fields. */
export const b64urlToBuffer = (text) => b64urlToBytes(text).buffer;

const withIds = (list) => (Array.isArray(list) ? list.map((c) => ({ ...c, id: b64urlToBuffer(c.id) })) : list);

/** The router's creation options (binary fields as base64url) as navigator.credentials.create({ publicKey }) needs them. */
export function credentialCreateOptions(publicKey) {
  const pk = publicKey || {};
  const out = { ...pk, challenge: b64urlToBuffer(pk.challenge), user: { ...pk.user, id: b64urlToBuffer(pk.user?.id) } };
  if (pk.excludeCredentials) out.excludeCredentials = withIds(pk.excludeCredentials);
  return out;
}

/** The router's request options as navigator.credentials.get({ publicKey }) needs them. */
export function credentialGetOptions(publicKey) {
  const pk = publicKey || {};
  const out = { ...pk, challenge: b64urlToBuffer(pk.challenge) };
  if (pk.allowCredentials) out.allowCredentials = withIds(pk.allowCredentials);
  return out;
}

/** A new passkey (PublicKeyCredential from create()) as the body of POST /api/v1/teams/join. */
export function encodeRegistration(cred) {
  return {
    id: cred.id || bytesToB64url(cred.rawId),
    rawId: bytesToB64url(cred.rawId),
    type: "public-key",
    response: { clientDataJSON: bytesToB64url(cred.response.clientDataJSON), attestationObject: bytesToB64url(cred.response.attestationObject) },
  };
}

/** A passkey assertion (PublicKeyCredential from get()) as the body of POST /api/v1/teams/:id/sign-in. */
export function encodeAssertion(cred) {
  const r = cred.response;
  const userHandle = r.userHandle && asBytes(r.userHandle).length ? bytesToB64url(r.userHandle) : null;
  return {
    id: cred.id || bytesToB64url(cred.rawId),
    response: { clientDataJSON: bytesToB64url(r.clientDataJSON), authenticatorData: bytesToB64url(r.authenticatorData), signature: bytesToB64url(r.signature), ...(userHandle ? { userHandle } : {}) },
  };
}

export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/** Plain words for the DOMExceptions a passkey prompt throws. */
export function passkeyError(e) {
  switch (e?.name) {
    case "NotAllowedError":
      return "The passkey prompt was closed or timed out. Try again when you are ready.";
    case "InvalidStateError":
      return "This device already holds a passkey for this organisation. Sign in with it instead.";
    case "SecurityError":
      return "Passkeys work only on the router's own address over HTTPS, or on localhost.";
    case "NotSupportedError":
      return "This device cannot make a passkey with the algorithms the router accepts (ES256, EdDSA, RS256).";
    case "AbortError":
      return "The passkey prompt was cancelled.";
    default:
      return e?.message || String(e);
  }
}

// ---------- canonical JSON and the hash chain ----------

export const GENESIS = "0".repeat(64);
export const AUDIT_FORMAT = "anyroute.audit.v1";
export const HASH_RULE = "sha256(bytes(prev_hash) || utf8(canonical_json({team, seq, at, actor, action, target, detail})))";

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}
/** JSON with object keys sorted recursively and undefined dropped: the same bytes the router hashes. */
export const canonicalJson = (value) => JSON.stringify(canonical(value));

/** The part of an entry that is hashed. The team id comes from the entry, or from `team` when the entry has none (CSV). */
export const entryPayload = (e, team) => ({ team: e.team ?? team, seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail });

export function hexToBytes(hex) {
  const s = String(hex || "");
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new Error("Not a hex string.");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const bytesToHex = (bytes) => Array.from(asBytes(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser cannot compute SHA-256 here (WebCrypto needs HTTPS or localhost).");
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

/** h_i from h_{i-1} and entry i, as lowercase hex. */
export async function chainHash(prevHex, entry, team) {
  return bytesToHex(await sha256(concat(hexToBytes(prevHex), new TextEncoder().encode(canonicalJson(entryPayload(entry, team))))));
}

/**
 * Recompute a chain in the order given. Returns { ok: true, checked, head } or
 * { ok: false, seq, reason, message, checked } for the first entry that does not hold:
 *   order: its seq is not the one after the previous entry's (reordered, removed or inserted)
 *   link:  its prev_hash is not the previous entry's hash
 *   hash:  its content does not hash to its hash (edited)
 *   head:  the chain does not end at the head the router reported
 */
export async function verifyChain(entries, { genesis = GENESIS, team, head } = {}) {
  let prev = genesis;
  let expect = entries[0]?.seq ?? 1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const fail = (reason, message) => ({ ok: false, seq: e.seq, index: i, reason, message, checked: i });
    if (e.seq !== expect) return fail("order", `Expected entry ${expect} here, found ${e.seq}: an entry was removed, added or moved.`);
    if (e.prev_hash !== undefined && e.prev_hash !== prev) return fail("link", "Its prev_hash is not the hash of the entry before it.");
    let h;
    try {
      h = await chainHash(prev, e, team);
    } catch (err) {
      if (/WebCrypto/.test(err?.message)) throw err;
      return fail("hash", "Its hashes are not valid hex.");
    }
    if (h !== e.hash) return fail("hash", "Its content does not match its hash: the entry was changed after it was written.");
    prev = h;
    expect++;
  }
  if (head?.hash && entries.length) {
    const last = entries[entries.length - 1].seq;
    if (head.seq > last) return { ok: false, seq: last + 1, reason: "missing", message: `The log has ${head.seq} entries; only ${last} were checked.`, checked: entries.length };
    if (head.seq === last && head.hash !== prev) return { ok: false, seq: last, reason: "head", message: "The chain does not end at the head hash the router reported.", checked: entries.length };
  }
  return { ok: true, checked: entries.length, head: prev, first: entries[0]?.seq ?? null, last: entries.at(-1)?.seq ?? null };
}

/** Add prev_hash and hash to entries, in order, from `genesis`: how the router writes the chain (used for the sample log). */
export async function sealEntries(team, entries, genesis = GENESIS) {
  const out = [];
  let prev = genesis;
  for (const e of entries) {
    const hash = await chainHash(prev, e, team);
    out.push({ team, ...e, prev_hash: prev, hash });
    prev = hash;
  }
  return out;
}

// ---------- hourly Merkle roots (RFC 6962) ----------

const splitPoint = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

/** RFC 6962 root over raw 32-byte entry hashes: leaf = sha256(0x00 || h), node = sha256(0x01 || left || right). */
export async function merkleRoot(hashes) {
  if (!hashes.length) return bytesToHex(await sha256(new Uint8Array(0)));
  const leaves = await Promise.all(hashes.map((h) => sha256(concat(Uint8Array.of(0), hexToBytes(h)))));
  const root = async (nodes) => {
    if (nodes.length === 1) return nodes[0];
    const k = splitPoint(nodes.length);
    return sha256(concat(Uint8Array.of(1), await root(nodes.slice(0, k)), await root(nodes.slice(k))));
  };
  return bytesToHex(await root(leaves));
}

export const hourOf = (at) => String(at).slice(0, 13) + ":00:00Z";

/** One root per UTC hour, as GET /audit/roots and the export return them. */
export async function hourlyRoots(entries) {
  const groups = [];
  for (const e of entries) {
    const hour = hourOf(e.at);
    if (!groups.length || groups.at(-1).hour !== hour) groups.push({ hour, items: [] });
    groups.at(-1).items.push(e);
  }
  return Promise.all(groups.map(async (g) => ({ hour: g.hour, first_seq: g.items[0].seq, last_seq: g.items.at(-1).seq, count: g.items.length, root: await merkleRoot(g.items.map((e) => e.hash)) })));
}

/** Recompute every hourly root the router published from the entries. Returns { ok, checked } or the first hour that differs. */
export async function verifyRoots(entries, roots) {
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  for (const r of roots || []) {
    const items = [];
    for (let s = r.first_seq; s <= r.last_seq; s++) {
      const e = bySeq.get(s);
      if (!e) return { ok: false, hour: r.hour, reason: "missing", message: `The root for ${r.hour} covers entry ${s}, which is not in the log.` };
      items.push(e);
    }
    if (items.length !== r.count) return { ok: false, hour: r.hour, reason: "count", message: `The root for ${r.hour} says ${r.count} entries; entries ${r.first_seq} to ${r.last_seq} are ${items.length}.` };
    if (items.some((e) => hourOf(e.at) !== hourOf(r.hour))) return { ok: false, hour: r.hour, reason: "hour", message: `An entry under the root for ${r.hour} was written in another hour.` };
    if ((await merkleRoot(items.map((e) => e.hash))) !== r.root) return { ok: false, hour: r.hour, reason: "root", message: `The Merkle root for ${r.hour} does not match its entries.` };
  }
  return { ok: true, checked: (roots || []).length };
}

// ---------- export files ----------

const csvCell = (v) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_COLUMNS = ["team", "seq", "at", "actor", "action", "target", "detail", "prev_hash", "hash"];

/** The JSONL export: a header line, one line per entry, one line per hourly root. */
export async function exportJsonl(team, entries, exportedAt = new Date()) {
  const head = entries.at(-1)?.hash ?? GENESIS;
  const lines = [JSON.stringify({ type: "header", format: AUDIT_FORMAT, team, genesis: GENESIS, hash: HASH_RULE, entries: entries.length, head, exported_at: new Date(exportedAt).toISOString() })];
  for (const e of entries) lines.push(JSON.stringify({ type: "entry", ...e }));
  for (const r of await hourlyRoots(entries)) lines.push(JSON.stringify({ type: "root", ...r }));
  return lines.join("\n") + "\n";
}

/** The CSV export (RFC 4180): the team column first, because the hash covers it; detail is the canonical JSON string. */
export function exportCsv(entries, team) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const e of entries) lines.push([e.team ?? team, e.seq, e.at, e.actor, e.action, e.target, canonicalJson(e.detail), e.prev_hash, e.hash].map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("The CSV ends inside a quoted cell.");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/**
 * Read an audit export. JSONL: { format: "jsonl", header, entries, roots }. CSV: { format: "csv", header: null, entries,
 * roots: [] } (a CSV has no header line or roots; each row carries its team). Throws with the line number on bad input.
 */
export function parseExport(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  if (src.startsWith(CSV_COLUMNS.join(","))) {
    const [cols, ...rows] = csvRows(src);
    if (cols.join(",") !== CSV_COLUMNS.join(",")) throw new Error("The CSV header is not " + CSV_COLUMNS.join(",") + ".");
    const entries = rows.map((r, i) => {
      if (r.length !== CSV_COLUMNS.length) throw new Error(`CSV row ${i + 2} has ${r.length} cells, not ${CSV_COLUMNS.length}.`);
      let detail;
      try {
        detail = JSON.parse(r[6]);
      } catch {
        throw new Error(`CSV row ${i + 2}: detail is not JSON.`);
      }
      return { team: r[0], seq: Number(r[1]), at: r[2], actor: r[3], action: r[4], target: r[5], detail, prev_hash: r[7], hash: r[8] };
    });
    return { format: "csv", header: null, entries, roots: [] };
  }
  let header = null;
  const entries = [];
  const roots = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`Line ${i + 1} is not JSON.`);
    }
    const { type, ...rest } = obj || {};
    if (type === "header") {
      if (header || entries.length) throw new Error(`Line ${i + 1}: the header must be the first line, once.`);
      header = rest;
    } else if (type === "entry") entries.push(rest);
    else if (type === "root") roots.push(rest);
    else throw new Error(`Line ${i + 1} has an unknown type: ${JSON.stringify(type)}.`);
  });
  if (!header) throw new Error("There is no header line: this is not an Anyroute audit export.");
  if (header.format !== AUDIT_FORMAT) throw new Error(`The format is ${JSON.stringify(header.format)}, not ${AUDIT_FORMAT}.`);
  return { format: "jsonl", header, entries, roots };
}

/** Check a parsed export end to end: the chain from its genesis, the header's count and head, and every hourly root. */
export async function verifyExport(parsed, { team } = {}) {
  const t = parsed.header?.team ?? parsed.entries[0]?.team ?? team;
  const chain = await verifyChain(parsed.entries, { genesis: parsed.header?.genesis ?? GENESIS, team: t });
  if (!chain.ok) return { ...chain, team: t };
  if (parsed.header) {
    if (parsed.header.entries !== parsed.entries.length) return { ok: false, reason: "count", message: `The header says ${parsed.header.entries} entries; the file has ${parsed.entries.length}.`, team: t };
    if (parsed.header.head !== (chain.head ?? GENESIS)) return { ok: false, reason: "head", message: "The last entry's hash is not the head in the header.", team: t };
  }
  const roots = await verifyRoots(parsed.entries, parsed.roots);
  if (!roots.ok) return { ...roots, team: t };
  return { ok: true, team: t, checked: chain.checked, head: chain.head ?? GENESIS, roots: roots.checked };
}

/** The file name in a Content-Disposition header, or "". */
export function dispositionName(header) {
  const h = String(header || "");
  const star = h.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const m = h.match(/filename\s*=\s*"?([^";]+)"?/i);
  return m ? m[1].trim() : "";
}

// ---------- the sample organisation (demo mode only, never sent anywhere) ----------

export const SAMPLE_TEAM_ID = "team_5a3c9e1f7b2d4a6c8e0f1a2b";
const hash64 = (seed) => (seed + "0123456789abcdef".repeat(4)).slice(0, 64);
const K = { pk: hash64("9c2e5a71f04d38b6"), wallet: hash64("27d9b3e05c8a1f46"), staging: hash64("b3a90d6c1e7f2485"), ci: hash64("e81f4c26b9a0d573"), pk2: hash64("6f0b1d94c2a8e357") };
const P = { safe: "tp_0d4e7a91c3b25f68", pk: "tp_7f3a9c2e41b8d605", wallet: "tp_c14e8b27d9a3f560", pk2: "tp_b92d6e04a7c15f38" };
const SAMPLE_SAFE = "0x5afe5afe00000000000000000000000000c0ffee";
const SAMPLE_WALLET = "0x0000000000000000000000000000000000a11ce5";

export const sampleTeam = {
  sample: true,
  id: SAMPLE_TEAM_ID,
  name: "Sample research org",
  created_at: "2026-09-28T09:12:04.000Z",
  owner: { account: "acct_sample", address: SAMPLE_SAFE, kind: "contract", verified_at: "2026-09-28T09:20:41.000Z" },
  budget_usd: 500,
  allocated_usd: 320,
  your_role: "owner",
  members: [
    { key_hash: K.pk, role: "admin", principal: P.pk, name: "passkey sign-in", disabled: false },
    { key_hash: K.ci, role: "agent", principal: null, name: "CI agent", disabled: false },
    { key_hash: K.staging, role: "dev", principal: null, name: "Staging app", disabled: false },
    { key_hash: K.wallet, role: "dev", principal: P.wallet, name: "wallet sign-in", disabled: false },
    { key_hash: K.pk2, role: "viewer", principal: P.pk2, name: "passkey sign-in", disabled: true },
  ],
  principals: [
    { id: P.safe, kind: "wallet", subject: SAMPLE_SAFE, role: "owner", disabled: false, created_at: "2026-09-28T09:20:41.000Z", last_used: "2026-09-28T09:58:02.000Z" },
    { id: P.pk, kind: "passkey", subject: "Xk3vQ9b2LmT0aP7s", role: "admin", disabled: false, created_at: "2026-09-28T10:02:15.000Z", last_used: "2026-09-30T08:41:00.000Z" },
    { id: P.wallet, kind: "wallet", subject: SAMPLE_WALLET, role: "dev", disabled: false, created_at: "2026-09-29T14:30:52.000Z", last_used: "2026-09-30T11:05:00.000Z" },
    { id: P.pk2, kind: "passkey", subject: "r8WmN2cYq5Ez1Hd4", role: "viewer", disabled: true, created_at: "2026-09-29T16:11:09.000Z", last_used: "2026-09-29T16:11:09.000Z" },
  ],
  audit: { entries: 0, head: GENESIS },
};

/** The sample log before hashing, in the router's shapes; sealEntries(SAMPLE_TEAM_ID, sampleAuditEntries) chains it. */
export const sampleAuditEntries = [
  { seq: 1, at: "2026-09-28T09:12:04.000Z", actor: "key:4be1c07d93a25f68", action: "team.create", target: SAMPLE_TEAM_ID, detail: { budget_usd: null, name: "Sample research org", owner: "acct_sample" } },
  { seq: 2, at: "2026-09-28T09:20:41.000Z", actor: "key:4be1c07d93a25f68", action: "owner.bind", target: SAMPLE_SAFE, detail: { kind: "contract", previous: null } },
  { seq: 3, at: "2026-09-28T09:58:02.000Z", actor: "wallet:" + SAMPLE_SAFE, action: "invite.create", target: "3f9a1c07d25e84b6", detail: { expires_at: "2026-10-01T09:58:02.000Z", method: "passkey", role: "admin" } },
  { seq: 4, at: "2026-09-28T10:02:15.000Z", actor: "passkey:" + P.pk, action: "member.join", target: P.pk, detail: { invite: "3f9a1c07d25e84b6", kind: "passkey", role: "admin" } },
  { seq: 5, at: "2026-09-28T10:02:15.000Z", actor: "passkey:" + P.pk, action: "key.create", target: K.pk, detail: { expires_at: "2026-09-28T22:02:15.000Z", limit_usd: 0, role: "admin", via: "passkey" } },
  { seq: 6, at: "2026-09-28T10:05:47.000Z", actor: "passkey:" + P.pk, action: "key.create", target: K.ci, detail: { limit_usd: 60, role: "agent" } },
  { seq: 7, at: "2026-09-28T10:06:30.000Z", actor: "passkey:" + P.pk, action: "key.create", target: K.staging, detail: { limit_usd: 260, role: "dev" } },
  { seq: 8, at: "2026-09-28T10:07:12.000Z", actor: "passkey:" + P.pk, action: "budget.set", target: SAMPLE_TEAM_ID, detail: { budget_usd: 500, previous_usd: null } },
  { seq: 9, at: "2026-09-29T14:21:10.000Z", actor: "passkey:" + P.pk, action: "invite.create", target: "b72e40c95a1d3f86", detail: { expires_at: "2026-09-30T14:21:10.000Z", method: "wallet", role: "dev" } },
  { seq: 10, at: "2026-09-29T14:30:52.000Z", actor: "wallet:" + SAMPLE_WALLET, action: "member.join", target: P.wallet, detail: { invite: "b72e40c95a1d3f86", kind: "wallet", role: "dev" } },
  { seq: 11, at: "2026-09-29T14:30:52.000Z", actor: "wallet:" + SAMPLE_WALLET, action: "key.create", target: K.wallet, detail: { expires_at: "2026-09-30T02:30:52.000Z", limit_usd: 0, role: "dev", via: "wallet" } },
  { seq: 12, at: "2026-09-29T14:44:18.000Z", actor: "wallet:" + SAMPLE_WALLET, action: "preset.save", target: "support", detail: { hash: "9f2c4e6a8b0d", version: 3 } },
  { seq: 13, at: "2026-09-29T16:02:40.000Z", actor: "passkey:" + P.pk, action: "invite.create", target: "51c8e2a07b94d3f1", detail: { expires_at: "2026-10-02T16:02:40.000Z", method: "any", role: "dev" } },
  { seq: 14, at: "2026-09-29T16:11:09.000Z", actor: "passkey:" + P.pk2, action: "member.join", target: P.pk2, detail: { invite: "51c8e2a07b94d3f1", kind: "passkey", role: "dev" } },
  { seq: 15, at: "2026-09-30T08:40:12.000Z", actor: "passkey:" + P.pk, action: "member.role", target: P.pk2, detail: { kind: "passkey", previous: "dev", role: "viewer" } },
  { seq: 16, at: "2026-09-30T08:41:00.000Z", actor: "passkey:" + P.pk, action: "member.revoke", target: P.pk2, detail: { keys_disabled: 1, kind: "passkey" } },
  { seq: 17, at: "2026-09-30T11:05:00.000Z", actor: "wallet:" + SAMPLE_WALLET, action: "route.update", target: "support-chat", detail: { fields: ["models", "provider"] } },
];
