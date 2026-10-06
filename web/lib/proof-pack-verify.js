// B122: browser port of scripts/verify-proof-pack.mjs. Keep agreement tests with the independent script.
// Parsing and checks run in a dedicated worker; receipt signatures reuse the public Verify checker.
import { canonicalJson, bytesToHex, base64ToBytes, keccak256, verifyMerkleProof, verifyReceipt, verifyReceiptV2, decodeReceiptV2 } from './verify.js';
export const PACK_TYPE = "anyroute.proof-pack.v1";
export const MANIFEST_TYPE = "anyroute.proof-pack.manifest.v1";
export const STATEMENT_TYPE = "anyroute.statement.v1";
const utf8 = s => new TextEncoder().encode(s);
const hex = bytesToHex;
const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const b64 = s => { try { return typeof s === 'string' ? base64ToBytes(s) : null; } catch { return null; } };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const leafOf = bytes => '0x' + hex(keccak256(keccak256(bytes)));
const merkleVerify = (leaf, proof, root) => typeof leaf === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(leaf) && typeof root === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(root) && Array.isArray(proof) && proof.every(p => typeof p === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(p)) && verifyMerkleProof(leaf, proof, root);
const decodeCose = decodeReceiptV2;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const pico = (value) => {
  if (typeof value !== "string" || !/^-?\d+(\.\d{1,12})?$/.test(value)) throw new Error("bad amount");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return (BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"))) * (value.startsWith("-") ? -1n : 1n);
};
/** Opening + deposits + refunds - usage - fees + other = closing; every usage grouping and the movements add up. */
export function statementReconciles(p) {
  try {
    if (pico(p.opening_balance) + pico(p.deposits) + pico(p.refunds) - pico(p.usage) - pico(p.fees) + pico(p.other_changes) !== pico(p.closing_balance)) return false;
    for (const name of ["usage_by_model", "usage_by_key_agent", "usage_by_lane"]) if (!Array.isArray(p[name]) || p[name].reduce((s, r) => s + pico(r.amount), 0n) !== pico(p.usage)) return false;
    return Array.isArray(p.movements_by_kind) && pico(p.opening_balance) + p.movements_by_kind.reduce((s, r) => s + pico(r.amount), 0n) === pico(p.closing_balance);
  } catch {
    return false;
  }
}

// The lanes whose endpoints all hold a fresh hardware attestation the router verified: "proven hardware".
export const PROVEN_LANES = ["attested", "unlinkable"];
const LANE_ORDER = ["public", "attested", "unlinkable"];
/** part / whole to four decimal places, rounded half up; null when whole is 0. The router computes shares the same way. */
export const shareOf = (part, whole) => (whole === 0n ? null : Number((part * 20000n + whole) / (2n * whole)) / 10000);
const evidenceUrl = (provider) => `/verify/?p=${encodeURIComponent(provider)}`;
const attestationUrl = (provider) => `/api/v1/attestation/${encodeURIComponent(provider)}`;

/**
 * Recompute a lane report from the calls it covers and compare: totals, every lane (calls, spend, shares), the proven
 * share, and every provider and model row on the proven lanes with its evidence links. Returns a list of problems.
 */
export function laneReportProblems(report, calls) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (!report || typeof report !== "object") return ["it is missing or not an object"];
  try {
    let total = 0n, spend = 0n;
    const lanes = new Map(LANE_ORDER.map((l) => [l, { calls: 0n, spend: 0n }]));
    const rows = new Map();
    for (const c of calls) {
      const lane = c?.lane ?? null, amount = pico(c?.cost);
      total += 1n;
      spend += amount;
      const t = lanes.get(lane) ?? { calls: 0n, spend: 0n };
      t.calls += 1n;
      t.spend += amount;
      lanes.set(lane, t);
      if (!PROVEN_LANES.includes(lane)) continue;
      const id = JSON.stringify([lane, c.provider, c.model]);
      const r = rows.get(id) ?? { calls: 0n, spend: 0n };
      r.calls += 1n;
      r.spend += amount;
      rows.set(id, r);
    }
    if (report.totals?.calls !== Number(total) || pico(report.totals?.spend) !== spend) bad(`the totals (${report.totals?.calls} calls, ${report.totals?.spend}) are not the ${total} calls and ${spend} pico-USDG listed`);

    const listedLanes = Array.isArray(report.lanes) ? report.lanes : [];
    if (!Array.isArray(report.lanes)) bad("it has no lane list");
    let laneCalls = 0n, laneSpend = 0n;
    const seen = new Set();
    for (const row of listedLanes) {
      const lane = row?.lane ?? null, name = lane ?? "not recorded";
      if (seen.has(lane)) bad(`lane ${name} is listed twice`);
      seen.add(lane);
      const want = lanes.get(lane) ?? { calls: 0n, spend: 0n };
      const got = { calls: BigInt(row.calls), spend: pico(row.spend) };
      laneCalls += got.calls;
      laneSpend += got.spend;
      if (got.calls !== want.calls || got.spend !== want.spend) bad(`lane ${name}: ${row.calls} calls and ${row.spend} listed, but the calls in this file give ${want.calls} and ${want.spend} pico-USDG`);
      if (row.share_of_calls !== shareOf(got.calls, total) || row.share_of_spend !== shareOf(got.spend, spend)) bad(`lane ${name}: its shares do not match its calls and spend`);
      if (row.proven !== PROVEN_LANES.includes(lane)) bad(`lane ${name}: marked ${row.proven ? "proven" : "not proven"}`);
    }
    for (const [lane, t] of lanes) if (t.calls > 0n && !seen.has(lane)) bad(`lane ${lane ?? "not recorded"} has calls in this file but is not listed`);
    if (laneCalls !== total || laneSpend !== spend) bad("the lanes do not add up to the totals");

    const p = report.proven ?? {};
    const provenCalls = PROVEN_LANES.reduce((n, l) => n + (lanes.get(l)?.calls ?? 0n), 0n), provenSpend = PROVEN_LANES.reduce((n, l) => n + (lanes.get(l)?.spend ?? 0n), 0n);
    if (canonicalJson(p.lanes) !== canonicalJson(PROVEN_LANES)) bad("the proven share does not name the attested and unlinkable lanes");
    if (BigInt(p.calls ?? -1) !== provenCalls || pico(p.spend) !== provenSpend) bad(`the proven share (${p.calls} calls, ${p.spend}) is not the ${provenCalls} calls and ${provenSpend} pico-USDG on the proven lanes`);
    if (p.share_of_calls !== shareOf(provenCalls, total) || p.share_of_spend !== shareOf(provenSpend, spend)) bad("the proven shares do not match");

    const providers = Array.isArray(report.providers) ? report.providers : [];
    if (!Array.isArray(report.providers)) bad("it has no provider list");
    let rowCalls = 0n, rowSpend = 0n;
    const listed = new Set();
    for (const row of providers) {
      const id = JSON.stringify([row?.lane, row?.provider, row?.model]), name = `${row?.provider} ${row?.model} on ${row?.lane}`;
      if (listed.has(id)) bad(`provider ${name} is listed twice`);
      listed.add(id);
      if (!PROVEN_LANES.includes(row?.lane)) bad(`provider ${name}: provider rows cover only the proven lanes`);
      const want = rows.get(id) ?? { calls: 0n, spend: 0n };
      const got = { calls: BigInt(row.calls), spend: pico(row.spend) };
      rowCalls += got.calls;
      rowSpend += got.spend;
      if (got.calls !== want.calls || got.spend !== want.spend) bad(`provider ${name}: ${row.calls} calls and ${row.spend} listed, but the calls in this file give ${want.calls} and ${want.spend} pico-USDG`);
      if (row.evidence_url !== evidenceUrl(row.provider) || row.attestation_url !== attestationUrl(row.provider)) bad(`provider ${name}: its evidence links do not point at its own attestation record`);
    }
    for (const id of rows.keys()) if (!listed.has(id)) bad(`provider ${JSON.parse(id).slice(1).join(" ")} on ${JSON.parse(id)[0]} has calls in this file but is not listed`);
    if (rowCalls !== provenCalls || rowSpend !== provenSpend) bad("the provider rows do not add up to the proven share");
  } catch {
    bad("it holds a value that is not a count or an amount");
  }
  return problems;
}

/** The lane, provider and model a call lists must be the ones its signed receipt states, where the receipt states them. */
function signedFacts(label, call, facts, fail) {
  for (const [name, value] of Object.entries(facts)) if (value !== undefined && value !== null && value !== call[name]) fail(`${label}: the listed ${name} ${call[name]} is not the signed ${value}`);
}

export const DECISION_TAG = /^sha256:[0-9a-f]{64}$/;
/** sha256:<hex> of an order's canonical JSON: the hash the decision-receipt helpers and the SDKs send as a decision tag. */
export const orderIntentHash = async (order) => `sha256:${hex(await sha256(utf8(canonicalJson(order))))}`;

/**
 * The pack's decision tag list against the tags its signed receipts carry (`signed`: call id -> tag or null, for every call
 * whose receipt verified): one row per tagged call, each tag the signed one, and no tagged call left out. A list of problems.
 */
export function decisionTagProblems(list, signed) {
  if (!Array.isArray(list)) return ["it is not a list"];
  const problems = [];
  const seen = new Set();
  for (const row of list) {
    const id = row?.id, label = `call ${id}`;
    if (seen.has(id)) problems.push(`${label} is listed twice`);
    seen.add(id);
    if (typeof row?.decision_tag !== "string" || !DECISION_TAG.test(row.decision_tag)) problems.push(`${label}: ${row?.decision_tag} is not sha256: and 64 lowercase hex characters`);
    else if (!signed.has(id)) problems.push(`${label}: no call with a verified receipt has this id`);
    else if (signed.get(id) !== row.decision_tag) problems.push(`${label}: the listed tag is not the one its signed receipt carries (${signed.get(id) ?? "none"})`);
  }
  for (const [id, tag] of signed) if (tag && !seen.has(id)) problems.push(`call ${id}: its signed receipt carries ${tag}, but the list leaves it out`);
  return problems;
}

async function keyring(jwks, fail, yieldUI) {
  const keys = new Map();
  let count = 0;
  for (const k of Array.isArray(jwks?.keys) ? jwks.keys : []) {
    if (++count % 20 === 0) await yieldUI();
    const raw = b64(k?.x);
    if (k?.kty !== 'OKP' || k?.crv !== 'Ed25519' || !raw || raw.length !== 32) {
      fail(`key ${k?.kid ?? '(no id)'}: not a 32-byte Ed25519 key`); continue;
    }
    if (hex(await sha256(raw)).slice(0, 16) !== k.kid) {
      fail(`key ${k.kid}: its id does not match its bytes`); continue;
    }
    keys.set(k.kid, k);
  }
  return keys;
}
async function signedJson(doc, keys) {
  const sig = b64(doc?.sig);
  if (!doc?.payload || typeof doc.payload !== 'object' || !sig) return { ok: false, why: 'needs payload, sig and key_id' };
  if (!keys.has(doc.key_id)) return { ok: false, why: `signed by key ${doc.key_id}, which is not in this pack` };
  const checked = await verifyReceipt({ payload: doc.payload, sig: doc.sig, key_id: doc.key_id }, { keys: [...keys.values()] });
  const signature = checked.checks.find(c => c.id === 'signature');
  if (signature?.status === 'not_checked') return { ok: false, why: 'this browser cannot check Ed25519 signatures; use the offline script' };
  return signature?.status === 'pass' ? { ok: true, bytes: utf8(canonicalJson(doc.payload)), sig } : { ok: false, why: 'the signature does not verify: the contents were changed or not signed by that key' };
}
export async function verifyProofPack(input, { intents = [], keys: publishedKeys, onProgress = () => {}, yieldUI = pause } = {}) {
  const pack = input && typeof input === "object" && input.data && !input.type ? input.data : input;
  const failures = [];
  const fail = (m) => failures.push(m);
  const s = { lane_report: "absent", proven_calls: 0, proven_share_of_calls: null, calls: 0, receipts: 0, without_receipt: 0, v1_valid: 0, v2: 0, v2_valid: 0, paths: 0, paths_valid: 0, onchain_roots: new Set(), offchain_roots: new Set(), unrooted: 0, refunds: 0, refunds_valid: 0, statements: 0, statements_valid: 0, keys: 0, manifest: false, decision_tags: "absent", tagged_calls: 0, intents: [] };
  if (!pack || pack.type !== PACK_TYPE) {
    fail(`not an Anyroute proof pack (type ${pack?.type ?? "missing"}; expected ${PACK_TYPE})`);
    return finish(pack, s, failures);
  }
  const keys = await keyring(pack.keys, fail, yieldUI);
  let trusted = false;
  if (publishedKeys) {
    const published = await keyring(publishedKeys, m => fail(`published ${m}`), yieldUI);
    trusted = keys.size > 0;
    for (const [id, k] of keys) {
      if (!published.has(id) || hex(b64(published.get(id).x)) !== hex(b64(k.x))) {
        trusted = false;
        fail(`key ${id}: not in Anyroute’s published receipt keys`);
      }
    }
  }
  let processed = 0;
  const tick = async () => { if (++processed % 20 === 0) { onProgress(processed); await yieldUI(); } };
  s.keys = keys.size;
  const path = (label, leaf, anchor) => {
    if (!anchor) return;
    s.paths++;
    if (merkleVerify(leaf, anchor.proof, anchor.root)) {
      s.paths_valid++;
      (anchor.status === "confirmed" && anchor.tx ? s.onchain_roots : s.offchain_roots).add(String(anchor.root).toLowerCase());
    } else fail(`${label}: the Merkle path does not lead from the receipt's leaf to root ${anchor.root}`);
  };

  const ids = new Set();
  // Decision tags read from signature-verified contents only: call id -> tag (null when the receipt carries none).
  const signedTags = new Map();
  for (const call of Array.isArray(pack.calls) ? pack.calls : []) {
    await tick();
    s.calls++;
    const label = `call ${call?.id}`;
    if (ids.has(call?.id)) fail(`${label}: listed twice`);
    ids.add(call?.id);
    const r = call?.receipt;
    if (!r) {
      s.without_receipt++;
      continue;
    }
    s.receipts++;
    if (r.id !== call.id) fail(`${label}: the receipt is for ${r.id}`);
    let rooted = false;
    if (r.payload) {
      const v = await signedJson(r, keys);
      if (!v.ok) fail(`${label}: v1 ${v.why}`);
      else {
        s.v1_valid++;
        signedTags.set(call.id, r.payload.decision_tag ?? null);
        if (r.payload.id !== undefined && r.payload.id !== call.id) fail(`${label}: the signed receipt names call ${r.payload.id}`);
        signedFacts(label, call, { lane: r.payload.lane, provider: r.payload.provider, model: r.payload.model }, fail);
        const leaf = leafOf(concat(v.bytes, v.sig));
        if (r.leaf && leaf !== String(r.leaf).toLowerCase()) fail(`${label}: the v1 anchor leaf does not match the signed receipt`);
        else if (r.leaf) path(`${label} v1`, leaf, r.anchor);
        else if (r.anchor) fail(`${label}: a Merkle path without a leaf`);
        rooted ||= !!r.anchor;
      }
    }
    if (r.v2) {
      s.v2++;
      const bytes = b64(r.v2.cose);
      let d = null;
      try {
        d = bytes ? decodeCose(bytes) : null;
      } catch {
        d = null;
      }
      const key = d && keys.get(d.keyId);
      let ok = false;
      if (!d) fail(`${label}: v2 is not a readable COSE_Sign1`);
      else if (d.alg !== -8) fail(`${label}: v2 uses COSE algorithm ${d.alg}, not EdDSA`);
      else if (!key) fail(`${label}: v2 signed by key ${d.keyId}, which is not in this pack`);
      else {
        try {
          const checked = await verifyReceiptV2(r.v2.cose, { keys: [...keys.values()] });
          ok = checked.checks.some(c => c.id === "v2_signature" && c.status === "pass");
        } catch {
          ok = false;
        }
        if (!ok) fail(`${label}: the v2 COSE signature does not verify`);
      }
      if (ok) {
        s.v2_valid++;
        const v2Tag = d.claims?.decision_tag ?? null;
        if (signedTags.has(call.id) && signedTags.get(call.id) !== v2Tag) fail(`${label}: the signed v1 and v2 receipts carry different decision tags`);
        else signedTags.set(call.id, v2Tag);
        if (d.claims?.rid !== call.id) fail(`${label}: the signed v2 claims name call ${d.claims?.rid}`);
        if (r.v2.claims && canonicalJson(r.v2.claims) !== canonicalJson(d.claims)) fail(`${label}: the readable v2 claims differ from the signed claims`);
        signedFacts(`${label} v2`, call, { lane: d.claims?.lane, provider: d.claims?.node?.provider, model: d.claims?.model?.id }, fail);
        const leaf = leafOf(bytes);
        if (r.v2.leaf && leaf !== String(r.v2.leaf).toLowerCase()) fail(`${label}: the v2 anchor leaf does not match the signed receipt`);
        else if (r.v2.leaf) path(`${label} v2`, leaf, r.v2.anchor);
        else if (r.v2.anchor) fail(`${label}: a v2 Merkle path without a leaf`);
        rooted ||= !!r.v2.anchor;
      }
    }
    if (!r.payload && !r.v2) fail(`${label}: the receipt has neither a v1 payload nor a v2 encoding`);
    if (!rooted) s.unrooted++;
  }

  // The lane report section (absent from packs made before it existed): recomputed from the calls in this file.
  if (pack.lane_report !== undefined) {
    const problems = laneReportProblems(pack.lane_report, Array.isArray(pack.calls) ? pack.calls : []);
    for (const p of problems) fail(`lane report: ${p}`);
    s.lane_report = problems.length ? "failed" : "matches";
    s.proven_calls = Number(pack.lane_report?.proven?.calls) || 0;
    s.proven_share_of_calls = pack.lane_report?.proven?.share_of_calls ?? null;
  }

  // The decision tag list (absent from packs made before it existed): exactly the tags the signed receipts carry.
  if (pack.decision_tags !== undefined) {
    const problems = decisionTagProblems(pack.decision_tags, signedTags);
    for (const p of problems) fail(`decision tags: ${p}`);
    s.decision_tags = problems.length ? "failed" : "matches";
    s.tagged_calls = [...signedTags.values()].filter(Boolean).length;
  }
  // Orders given with --intent: which calls' signed receipts carry each order's hash.
  for (const intent of intents) {
    const tag = await orderIntentHash(intent.order);
    const calls = [...signedTags].filter(([, t]) => t === tag).map(([id]) => id);
    s.intents.push({ name: intent.name, tag, calls });
    if (!calls.length) fail(`order ${intent.name}: no signed receipt in this file carries its hash ${tag}`);
  }

  for (const r of Array.isArray(pack.refunds) ? pack.refunds : []) {
    await tick();
    s.refunds++;
    const label = `refund ${r?.id}`;
    const v = await signedJson(r, keys);
    if (!v.ok) {
      fail(`${label}: ${v.why}`);
      continue;
    }
    if (r.payload.kind !== "refund" || r.payload.id !== r.id) fail(`${label}: the signed payload is not this refund receipt`);
    else if (r.leaf && leafOf(concat(v.bytes, v.sig)) !== String(r.leaf).toLowerCase()) fail(`${label}: the anchor leaf does not match the signed receipt`);
    else {
      s.refunds_valid++;
      if (r.leaf) path(label, r.leaf, r.anchor);
    }
  }

  for (const st of Array.isArray(pack.statements) ? pack.statements : []) {
    await tick();
    s.statements++;
    const label = `statement ${st?.payload?.month}`;
    if (st?.payload?.type !== STATEMENT_TYPE) {
      fail(`${label}: not a monthly statement`);
      continue;
    }
    const v = await signedJson(st, keys);
    if (!v.ok) fail(`${label}: ${v.why}`);
    else if (!statementReconciles(st.payload)) fail(`${label}: the amounts do not reconcile`);
    else s.statements_valid++;
  }

  const m = pack.manifest;
  const mv = await signedJson(m, keys);
  if (!mv.ok) fail(`manifest: ${mv.why}`);
  else if (m.payload.type !== MANIFEST_TYPE) fail(`manifest: type ${m.payload.type}, expected ${MANIFEST_TYPE}`);
  else {
    const p = m.payload;
    const same = (a, b) => canonicalJson(a) === canonicalJson(b);
    const listed = {
      range: pack.range, scope: pack.scope, key_hash: pack.key_hash ?? null, part: pack.part, truncated: pack.truncated, next_cursor: pack.next_cursor ?? null, generated_at: pack.generated_at, router: pack.router,
      calls: (pack.calls ?? []).map((c) => ({ id: c.id, leaf: c.receipt?.leaf ?? null, leaf_v2: c.receipt?.v2?.leaf ?? null })),
      refunds: (pack.refunds ?? []).map((r) => ({ id: r.id, leaf: r.leaf ?? null })),
      statements: (pack.statements ?? []).map((x) => ({ month: x.payload?.month, key_id: x.key_id, sig: x.sig })),
      key_ids: (pack.keys?.keys ?? []).map((k) => k.kid),
      lane_report: pack.lane_report ?? null,
      decision_tags: pack.decision_tags ?? null,
    };
    const differs = Object.keys(listed).filter((k) => !same(p[k] ?? null, listed[k] ?? null));
    if (differs.length) fail(`manifest: the signed manifest does not match this file (${differs.join(", ")})`);
    else s.manifest = true;
  }
  return { ...finish(pack, s, failures), signedByAnyroute: trusted && s.manifest };
}

function finish(pack, s, failures) {
  return { ok: failures.length === 0 && s.manifest, failures, summary: { ...s, onchain_roots: s.onchain_roots.size, offchain_roots: s.offchain_roots.size } };
}

/** Plain result lines; a missing receipt is never counted as checked. */
export function proofPackResultLines(result) {
  const s = result.summary;
  const lines = [`${s.calls} calls · ${s.receipts} receipts${result.ok ? ' checked' : ' found'}${result.ok ? ' ✓' : ''}`, `${s.statements_valid} statements${result.ok ? ' ✓' : ''}`];
  if (s.without_receipt) lines.push(`${s.without_receipt} calls have no signed receipt to check.`);
  if (s.refunds) lines.push(`${s.refunds_valid} of ${s.refunds} refund receipts checked.`);
  if (s.lane_report === 'matches') lines.push(s.proven_share_of_calls === null ? 'Lane report: no calls to measure.' : `Lane report: ${Number((s.proven_share_of_calls * 100).toFixed(2))}% on proven hardware`);
  else lines.push(s.lane_report === 'absent' ? 'Lane report: none in this file.' : 'Lane report: does not match the calls.');
  return lines;
}

/** Keep the script's detailed diagnostics for agreement checks, and present plain words on the page. */
export function proofPackFailureText(message) {
  if (message.startsWith('not an Anyroute proof pack')) return 'This file is not an Anyroute proof pack.';
  if (message.startsWith('manifest: type ')) return 'Pack contents list: this is not a signed proof pack contents list.';
  return message
    .replace(/manifest/g, 'pack contents list')
    .replace(/needs payload, sig and key_id/g, 'the signed contents, signature or signing key is missing')
    .replace(/COSE_Sign1/g, 'signed receipt')
    .replace(/v2 uses COSE algorithm .*?, not EdDSA/g, 'the second receipt uses an unsupported signature method')
    .replace(/v1/g, 'first receipt').replace(/v2/g, 'second receipt')
    .replace(/COSE signature/g, 'signature').replace(/anchor leaf/g, 'receipt fingerprint')
    .replace(/Merkle path/g, 'inclusion proof').replace(/receipt's leaf/g, 'receipt fingerprint')
    .replace(/pico-USDG/g, 'trillionths of USDG')
    .replace(/key_hash/g, 'key scope').replace(/key_ids/g, 'signing keys')
    .replace(/next_cursor/g, 'next part').replace(/generated_at/g, 'creation time')
    .replace(/lane_report/g, 'lane report').replace(/decision_tags/g, 'decision tags');
}
