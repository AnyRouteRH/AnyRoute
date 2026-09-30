import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { addressBucket } from "../api/common.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { ENTRY_KINDS, isEntryKind } from "./entries.ts";
import { CosignError, type CheckpointRow } from "./log.ts";
import { formatVerifierKey, SIG_COSIGNATURE_V1 } from "./note.ts";
import { parseTilePath } from "./merkle.ts";
import { ANCHOR_KEY_ALGORITHM, anchorView } from "./rekor.ts";

// The log in the C2SP tlog-tiles layout, and a small JSON API around it. Registered only when TLOG_ENABLED is on.
//
//   GET  /tlog/checkpoint                   newest checkpoint, signed by the log, with the cosignatures collected so far
//   GET  /tlog/tile/<L>/<N>[.p/<W>]         Merkle tree tiles (height 8)
//   GET  /tlog/tile/entries/<N>[.p/<W>]     entry bundles
//   GET  /api/v1/tlog                       the log's origin, verifier key, witnesses and quorum
//   GET  /api/v1/tlog/witnessed             newest checkpoint cosigned by at least the quorum of witnesses
//   GET  /api/v1/tlog/checkpoints/{size}    one checkpoint with its cosignatures
//   GET  /api/v1/tlog/lookup                the entry for a key (kind and SHA-256)
//   GET  /api/v1/tlog/proof                 an entry with its inclusion proof and, on request, a consistency proof
//   GET  /api/v1/tlog/consistency           a consistency proof between two tree sizes
//   POST /api/v1/tlog/cosignatures          a witness hands in its cosignature on a checkpoint
//   GET  /api/v1/tlog/rekor                 Rekor anchoring (TLOG_REKOR_ENABLED): the key, the newest anchor, a list
//   GET  /api/v1/tlog/rekor/key             the anchoring key (ECDSA P-256 public key)
//   GET  /api/v1/tlog/rekor/{size}          the Rekor entry that anchors one checkpoint
//
// Hashes in the JSON API are standard base64, as in checkpoints.

const MAX_NOTE_BYTES = 16_384;
const NOTE_TYPE = "text/plain; charset=utf-8";
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function sizeParam(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === "") return undefined;
  if (!/^(0|[1-9]\d{0,15})$/.test(v) || !Number.isSafeInteger(Number(v))) fail(400, `\`${name}\` must be a non-negative integer.`, "invalid_request");
  return Number(v);
}

async function boundedText(c: Context, limit: number): Promise<string> {
  if (Number(c.req.header("content-length") ?? 0) > limit) fail(413, `Request body is too large (${limit} bytes max).`, "payload_too_large");
  const body = c.req.raw.body;
  if (!body) return "";
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel().catch(() => undefined);
      fail(413, `Request body is too large (${limit} bytes max).`, "payload_too_large");
    }
    parts.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(parts));
}

export function tlogRoutes(app: Hono, ctx: Ctx) {
  const tlog = ctx.tlog!;
  const cfg = ctx.cfg.tlog;
  const text = (c: Context, body: string | Uint8Array, type: string, cache: string, status = 200) =>
    c.body(typeof body === "string" ? body : new Uint8Array(body), status as 200, { "content-type": type, "cache-control": cache, "access-control-allow-origin": "*", "x-content-type-options": "nosniff" });
  const notFound = (c: Context, message: string, type = "not_found") =>
    c.json(new ApiError(404, message, type).toJSON(), 404, { "cache-control": "no-store", "access-control-allow-origin": "*" });

  // ---- tlog-tiles ---------------------------------------------------------------------------------------------------

  app.get("/tlog/checkpoint", async (c) => text(c, await tlog.note(await tlog.checkpoint()), NOTE_TYPE, "no-cache"));

  app.get("/tlog/tile/*", async (c) => {
    const rest = new URL(c.req.url).pathname.slice("/tlog/tile/".length);
    const ref = parseTilePath(rest);
    if (!ref) return notFound(c, "Not a tile path (tlog-tiles: tile/<level>/<index>[.p/<width>]).");
    const bytes = await tlog.tile(ref);
    if (!bytes) return notFound(c, "The log has no such tile at this width yet.");
    // A tile of a given width never changes: a partial tile is a prefix of the full one.
    return text(c, bytes, "application/octet-stream", "public, max-age=31536000, immutable");
  });

  // ---- JSON API -----------------------------------------------------------------------------------------------------

  const checkpointView = async (cp: CheckpointRow) => {
    const cosigs = await tlog.cosignatures(cp.size);
    const view = { size: cp.size, root_hash: b64(Buffer.from(cp.rootHash, "hex")), note: await tlog.note(cp), cosigned_by: cosigs.map((x) => x.witness), witnessed: tlog.witnesses.length >= tlog.quorum && cosigs.length >= tlog.quorum };
    if (!tlog.rekor) return view;
    // With anchoring on, the checkpoint's Rekor entry (null until it is anchored).
    const anchor = await tlog.rekor.at(cp.size);
    return { ...view, rekor: anchor ? anchorView(anchor) : null };
  };
  const rekorKey = () => ({ algorithm: ANCHOR_KEY_ALGORITHM, key_id: tlog.rekor!.keyId, public_key_pem: tlog.rekor!.publicKeyPem });
  const rekorSummary = async () => {
    const latest = await tlog.rekor!.latest();
    return { rekor_url: tlog.rekor!.url, entry_type: "hashedrekord", ...rekorKey(), min_interval_ms: tlog.rekor!.minIntervalMs, latest: latest ? anchorView(latest) : null };
  };
  const rekorOff = (c: Context) => notFound(c, "This log does not anchor its checkpoints in Rekor (TLOG_REKOR_ENABLED is off).", "rekor_not_enabled");

  app.get("/api/v1/tlog", async (c) => {
    const cp = await tlog.checkpoint();
    const w = await tlog.witnessed();
    c.header("cache-control", "no-cache");
    return c.json({
      data: {
        origin: tlog.origin,
        verifier_key: tlog.verifierKey,
        formats: { tiles: "c2sp.org/tlog-tiles", checkpoint: "c2sp.org/tlog-checkpoint", cosignature: "c2sp.org/tlog-cosignature (cosignature/v1)" },
        kinds: ENTRY_KINDS,
        witnesses: tlog.witnesses.map((x) => ({ name: x.name, verifier_key: formatVerifierKey(x.name, SIG_COSIGNATURE_V1, x.publicKey) })),
        quorum: cfg.quorum,
        size: cp.size,
        checkpoint: await checkpointView(cp),
        witnessed_size: w?.size ?? null,
        tiles_url: `${ctx.cfg.publicUrl}/tlog/`,
        rekor: tlog.rekor ? await rekorSummary() : null,
      },
    });
  });

  // ---- Rekor anchoring ----------------------------------------------------------------------------------------------

  app.get("/api/v1/tlog/rekor", async (c) => {
    if (!tlog.rekor) return rekorOff(c);
    const limit = sizeParam(c.req.query("limit"), "limit") ?? 20;
    if (limit < 1 || limit > 100) fail(400, "`limit` must be between 1 and 100.", "invalid_request");
    const before = sizeParam(c.req.query("before"), "before");
    const rows = await tlog.rekor.list(limit, before);
    c.header("cache-control", "no-cache");
    return c.json({ data: { ...(await rekorSummary()), anchors: rows.map(anchorView), next_before: rows.length === limit ? rows[rows.length - 1].size : null } });
  });

  app.get("/api/v1/tlog/rekor/key", (c) => {
    if (!tlog.rekor) return rekorOff(c);
    c.header("cache-control", "public, max-age=300");
    return c.json({ data: rekorKey() });
  });

  app.get("/api/v1/tlog/rekor/:size", async (c) => {
    if (!tlog.rekor) return rekorOff(c);
    const size = sizeParam(c.req.param("size"), "size")!;
    const row = await tlog.rekor.at(size);
    if (!row) return notFound(c, "No Rekor entry anchors a checkpoint of that size.", "not_anchored");
    c.header("cache-control", "no-cache");
    return c.json({ data: anchorView(row) });
  });

  app.get("/api/v1/tlog/witnessed", async (c) => {
    const w = await tlog.witnessed();
    if (!w) return notFound(c, "No checkpoint has the required witness cosignatures yet.", "not_witnessed");
    return text(c, await tlog.note(w), NOTE_TYPE, "no-cache");
  });

  app.get("/api/v1/tlog/checkpoints/:size", async (c) => {
    const size = sizeParam(c.req.param("size"), "size")!;
    const cp = await tlog.checkpointAt(size);
    if (!cp) return notFound(c, "This log has not signed a checkpoint of that size.", "unknown_checkpoint");
    return text(c, await tlog.note(cp), NOTE_TYPE, "no-cache");
  });

  const keyParams = (c: Context) => {
    const kind = c.req.query("kind");
    const digest = (c.req.query("sha256") ?? "").toLowerCase();
    if (!isEntryKind(kind)) fail(400, `\`kind\` must be one of ${ENTRY_KINDS.join(", ")}.`, "invalid_request");
    if (!/^[0-9a-f]{64}$/.test(digest)) fail(400, "`sha256` must be 64 hex characters.", "invalid_request");
    return { kind, digest };
  };
  const notLogged = () => fail(404, "That key or configuration is not in the transparency log.", "not_logged");

  app.get("/api/v1/tlog/lookup", async (c) => {
    const { kind, digest } = keyParams(c);
    const row = (await tlog.lookup(kind, digest)) ?? notLogged();
    c.header("cache-control", "no-cache");
    return c.json({ data: { index: row.idx, kind: row.kind, sha256: row.sha256, subject: row.subject, entry: row.entry, leaf_hash: b64(Buffer.from(row.leafHash, "hex")) } });
  });

  app.get("/api/v1/tlog/proof", async (c) => {
    const { kind, digest } = keyParams(c);
    const wanted = sizeParam(c.req.query("size"), "size");
    const from = sizeParam(c.req.query("from"), "from");
    const row = (await tlog.lookup(kind, digest)) ?? notLogged();
    let cp: CheckpointRow | null;
    if (wanted !== undefined) {
      cp = await tlog.checkpointAt(wanted);
      if (!cp) fail(404, "This log has not signed a checkpoint of that size.", "unknown_checkpoint");
    } else cp = (await tlog.witnessed(row.idx + 1)) ?? (await tlog.anchored(row.idx + 1)) ?? (await tlog.checkpoint());
    if (cp!.size <= row.idx) fail(409, "That checkpoint does not include the entry yet.", "not_yet_included");
    const size = await tlog.size();
    let consistency = null;
    if (from !== undefined) {
      // A size beyond this tree gets no proof: the client then asks for one itself and refuses when there is none.
      const [a, b] = from <= cp!.size ? [from, cp!.size] : [cp!.size, from];
      if (b <= size) consistency = { from: a, to: b, proof: (await tlog.consistencyProof(a, b)).map(b64) };
    }
    c.header("cache-control", "no-cache");
    return c.json({
      data: {
        origin: tlog.origin,
        index: row.idx,
        kind: row.kind,
        sha256: row.sha256,
        subject: row.subject,
        entry: row.entry,
        checkpoint: await checkpointView(cp!),
        inclusion: (await tlog.inclusionProof(row.idx, cp!.size)).map(b64),
        consistency,
      },
    });
  });

  app.get("/api/v1/tlog/consistency", async (c) => {
    const from = sizeParam(c.req.query("from"), "from");
    const to = sizeParam(c.req.query("to"), "to");
    if (from === undefined || to === undefined) fail(400, "`from` and `to` are required.", "invalid_request");
    if (from! > to!) fail(400, "`from` must not be larger than `to`.", "invalid_request");
    if (to! > (await tlog.size())) fail(400, "`to` is larger than the tree.", "invalid_request");
    // Proofs between two sizes never change once both exist.
    c.header("cache-control", "public, max-age=3600");
    return c.json({ data: { from, to, proof: (await tlog.consistencyProof(from!, to!)).map(b64) } });
  });

  app.post("/api/v1/tlog/cosignatures", async (c) => {
    c.header("cache-control", "no-store");
    const from = addressBucket(c, ctx.cfg);
    const r = await ctx.limiter.take(`tlog-cosign:${from.id}`, 1, from.scale(cfg.cosignRpm), 60_000);
    if (!r.ok) fail(429, "Too many cosignature submissions; try again shortly.", "rate_limited");
    const note = await boundedText(c, MAX_NOTE_BYTES);
    try {
      const out = await tlog.addCosignatures(note);
      return c.json({ data: { size: out.size, accepted: out.accepted, cosignatures: out.cosignatures, witnessed: out.witnessed } });
    } catch (e) {
      if (e instanceof CosignError) fail(e.status, e.message, e.type);
      throw e;
    }
  });
}
