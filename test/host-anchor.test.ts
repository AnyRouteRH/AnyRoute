import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { hostAnchorLeaves, hostAnchors, kv, providers } from "../src/db/schema.ts";
import { saveTlsPin } from "../src/providers/tls-pin.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { attestProvider } from "../src/services/attestor.ts";
import { bindingFromBootDocument, checkLeaf, pinnedLeafFeed, providerIdHash, runHostAnchor, sidecarKeyId, type AttestedAnchorChain, type LeafFeed } from "../src/services/host-anchor.ts";
import { EnclaveSigner, ReceiptQueue, newReceiptId, type ReceiptEnvelope, type ReceiptPayload } from "../sidecar/src/receipts.ts";
import { createTlsIdentity, generateTlsKey } from "../sidecar/src/tls.ts";
import { verifyHostAnchor, type AttestedAnchor, type BoundIdentity, type HostAnchorProof } from "../packages/client/src/index.ts";
import { MODELS, fakeTx, startRouter, type Harness } from "./helpers.ts";
import { DIGESTS, bindingsFor, sidecarDocument } from "./measurement-fixtures.ts";

// Per-host anchoring of enclave receipts: each attested host's sidecar leaves are collected from its leaf feed, kept only
// when signed by the receipt key the router-verified attestation binds, rooted per host and interval, posted with
// ReceiptAnchor.anchorAttested where a chain is configured (a stand-in here) and kept off chain otherwise.

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const ZERO = "00".repeat(32);
const TOKENS: Record<string, string> = { "host-a": "anchor-token-a", "host-b": "anchor-token-b", "host-real": "anchor-token-real" };

type Host = {
  id: string;
  url: string;
  ref: string;
  signer: EnclaveSigner;
  queue: ReceiptQueue;
  hits: string[];
  /** Sign and queue a receipt the way the sidecar does. `signer`, `ref`, `dev` and `mutate` make it wrong on purpose. */
  issue: (o?: { signer?: EnclaveSigner; ref?: string; dev?: boolean; mutate?: (e: ReceiptEnvelope) => ReceiptEnvelope }) => ReceiptEnvelope;
  bound: () => BoundIdentity;
  stop: () => void;
};

function payload(ref: string, dev = false): ReceiptPayload {
  return {
    v: 1,
    type: "anyroute.sidecar.receipt",
    id: newReceiptId(),
    ts: Date.now(),
    path: "/v1/chat/completions",
    status: 200,
    stream: false,
    complete: true,
    req_hash: "sha256:" + sha(randomBytes(16)),
    resp_hash: "sha256:" + sha(randomBytes(16)),
    model_digest: DIGESTS.model,
    attestation_ref: ref,
    nullifier: "",
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    dev,
  };
}

/**
 * A sidecar on https://127.0.0.1: a self-signed certificate naming sha256 of its boot quote, bindings that commit its
 * TLS key and its receipt key, the sidecar's own signer and leaf queue, and the anchor endpoints behind a token.
 */
function sidecarHost(id: string, token: string): Host {
  const tls = generateTlsKey();
  const spkiHex = tls.spkiDer.toString("hex");
  const signer = EnclaveSigner.generate();
  const bindings = { ...bindingsFor(), tls_pubkey: spkiHex, receipt_pubkey: signer.publicKeyHex };
  const boot = sidecarDocument(ZERO, { bindings });
  const ref = sha(Buffer.from(boot.evidence.quote, "hex"));
  const cert = createTlsIdentity(tls.privateKey, { attestationRef: ref, hostnames: ["localhost"] });
  const queue = new ReceiptQueue(10_000);
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: cert.keyPem, cert: cert.certPem },
    fetch: async (req) => {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/attest") {
        const nonce = u.searchParams.get("nonce");
        return Response.json(nonce ? { ...sidecarDocument(nonce, { bindings }), attestation_ref: ref } : { ...boot, attestation_ref: ref });
      }
      if (u.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "m" }] });
      if (u.pathname.startsWith("/anchor/")) {
        if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (u.pathname === "/anchor/leaves") return Response.json(queue.pull(Number(u.searchParams.get("after") ?? 0), Number(u.searchParams.get("limit") ?? 100)));
        if (u.pathname === "/anchor/ack" && req.method === "POST") return Response.json(queue.ack(Number(((await req.json()) as { through_seq: number }).through_seq)));
      }
      return new Response("not found", { status: 404 });
    },
  });
  const issue: Host["issue"] = (o = {}) => {
    let env = (o.signer ?? signer).sign(payload(o.ref ?? ref, o.dev));
    if (o.mutate) env = o.mutate(env);
    queue.push(env);
    return env;
  };
  const bound = (): BoundIdentity => ({
    attestationRef: ref,
    attestationSan: "",
    tlsPubkey: spkiHex,
    receiptPubkey: signer.publicKeyHex,
    receiptKeyId: signer.keyId,
    hpkePubkey: null,
    imageDigest: DIGESTS.image.slice(7),
    composeHash: DIGESTS.compose.slice(7),
    modelDigest: DIGESTS.model,
    measurements: null,
    teeKind: "tdx",
  });
  return { id, url: `https://127.0.0.1:${server.port}`, ref, signer, queue, hits, issue, bound, stop: () => server.stop(true) };
}

/** A stand-in for ReceiptAnchor that records anchorAttested calls. */
function standInChain(o: { configured?: boolean } = {}) {
  const calls: { providerId: Hex; root: Hex; attestationRef: Hex }[] = [];
  const onchain: AttestedAnchor[] = [];
  const state = { failing: false };
  const chain: AttestedAnchorChain = {
    configured: () => o.configured ?? true,
    anchorAttested: async (providerId, root, attestationRef) => {
      if (state.failing) throw new Error("the chain is unreachable");
      calls.push({ providerId, root, attestationRef });
      onchain.push({ providerId, root, attestationRef, anchoredAt: Math.floor(Date.now() / 1000) });
      return { hash: fakeTx(), blockNumber: 7_000 + calls.length, index: onchain.length - 1 };
    },
  };
  return { chain, calls, state, read: async (i: number) => onchain[i] ?? null };
}

const offChain = standInChain({ configured: false });

describe("per-host anchoring of enclave receipts", () => {
  let h: Harness;
  let dcap: ReturnType<typeof Bun.serve>;
  const hosts: Record<string, Host> = {};
  const real = {
    boot: JSON.parse(readFileSync(new URL("../packages/client/test/fixtures/attest-boot.json", import.meta.url), "utf8")),
    receipt: JSON.parse(readFileSync(new URL("../packages/client/test/fixtures/receipt.json", import.meta.url), "utf8")) as ReceiptEnvelope,
    queue: new ReceiptQueue(10),
  };
  // host-a and host-b go over their pinned https connections; host-real replays evidence captured from a TDX deployment.
  let dropAck = false;
  const feed = (p: typeof providers.$inferSelect, pin: Parameters<typeof pinnedLeafFeed>[2], token: string): LeafFeed => {
    if (p.id === "host-real") return { attest: async () => real.boot, pull: async (after, limit) => real.queue.pull(after, limit), ack: async (through) => void real.queue.ack(through) };
    const f = pinnedLeafFeed(h.ctx, p, pin, token);
    return dropAck ? { ...f, ack: async () => Promise.reject(new Error("the acknowledgement was lost")) } : f;
  };
  const run = (chain: AttestedAnchorChain = offChain.chain) => runHostAnchor(h.ctx, { chain, feed }) as Promise<{ hosts: Record<string, any>; retried: number }>;
  const proof = async (leaf: string) => (await h.request(`/api/v1/host-anchors/proof/${leaf}`)).json() as Promise<{ data: HostAnchorProof }>;

  beforeAll(async () => {
    dcap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ verified: true }) });
    h = await startRouter({
      providers: ["host-a", "host-b", "host-real"].map((id) => ({ id, name: id, models: [MODELS.qwen] })),
      env: { TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify`, HOST_ANCHOR_ENABLED: "true", HOST_ANCHOR_TOKENS: JSON.stringify(TOKENS) },
    });
    // The router's own attestor proves and pins each https sidecar.
    for (const id of ["host-a", "host-b"]) {
      const s = (hosts[id] = sidecarHost(id, TOKENS[id]));
      await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `${s.url}/attest`, baseUrl: `${s.url}/v1` }).where(eq(providers.id, id));
      const [row] = await h.ctx.db.select().from(providers).where(eq(providers.id, id));
      expect(await attestProvider(h.ctx, row)).toMatchObject({ ok: true, tls_pin: { attestation_ref: s.ref } });
    }
    // The captured deployment: the pin the attestor recorded for it names sha256 of its boot quote.
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attested: true, attestationUrl: "https://captured.invalid/attest" }).where(eq(providers.id, "host-real"));
    await saveTlsPin(h.ctx.db, "host-real", { certPem: "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----", spkiSha256: real.boot.tls.spki_sha256, attestationRef: real.boot.attestation_ref, pinnedAt: new Date().toISOString() });
  });
  afterAll(async () => {
    for (const s of Object.values(hosts)) s.stop();
    dcap.stop(true);
    await h.close();
  });
  beforeEach(async () => {
    await h.ctx.db.delete(hostAnchorLeaves);
    await h.ctx.db.delete(hostAnchors);
    for (const s of Object.values(hosts)) s.queue.ack(s.queue.head);
    real.queue.ack(real.queue.head);
  });

  test("leaves from each sidecar are collected and rooted per host and per interval", async () => {
    const a = hosts["host-a"];
    const b = hosts["host-b"];
    const firstA = [a.issue(), a.issue(), a.issue()];
    const firstB = [b.issue(), b.issue()];
    const r1 = await run();
    expect(r1.hosts["host-a"]).toMatchObject({ attestation_ref: a.ref, receipt_key_id: a.signer.keyId, pulled: 3, rooted: 3, discarded: {}, acked: true, root: { count: 3, status: "local", tx: null } });
    expect(r1.hosts["host-b"]).toMatchObject({ attestation_ref: b.ref, pulled: 2, rooted: 2, root: { count: 2, status: "local" } });
    expect(r1.hosts["host-real"]).toMatchObject({ pulled: 0, root: null });
    // The sidecars were acknowledged over their pinned connections and dropped what was rooted.
    expect(a.queue.pending).toBe(0);
    expect(b.queue.pending).toBe(0);
    expect(a.hits).toContain("POST /anchor/ack");
    const rows = await h.ctx.db.select().from(hostAnchors).orderBy(hostAnchors.id);
    expect(rows.map((r) => [r.providerId, r.count, r.attestationRef, r.receiptPublicKey])).toEqual([
      ["host-a", 3, a.ref, a.signer.publicKeyHex],
      ["host-b", 2, b.ref, b.signer.publicKeyHex],
    ]);
    // In queue order, under the tree the router's own anchor uses.
    expect(rows[0].root).toBe(new MerkleTree(firstA.map((e) => e.leaf as Hex)).root);
    expect(rows[1].root).toBe(new MerkleTree(firstB.map((e) => e.leaf as Hex)).root);

    // Next interval: only host-a served anything. Its new root starts where its last one ended; nothing is rooted twice.
    const secondA = [a.issue(), a.issue()];
    const r2 = await run();
    expect(r2.hosts["host-a"]).toMatchObject({ rooted: 2, root: { count: 2 } });
    expect(r2.hosts["host-b"]).toMatchObject({ pulled: 0, root: null });
    const [, , next] = await h.ctx.db.select().from(hostAnchors).orderBy(hostAnchors.id);
    expect(next.providerId).toBe("host-a");
    expect(next.fromTs.getTime()).toBe(rows[0].toTs.getTime());
    expect(next.root).toBe(new MerkleTree(secondA.map((e) => e.leaf as Hex)).root);
    expect((await h.ctx.db.select().from(hostAnchorLeaves)).length).toBe(7);
  });

  test("a leaf already rooted is not rooted twice when the acknowledgement was lost", async () => {
    const a = hosts["host-a"];
    const first = [a.issue(), a.issue()];
    dropAck = true;
    const r1 = await run();
    dropAck = false;
    expect(r1.hosts["host-a"]).toMatchObject({ pulled: 2, rooted: 2, acked: false });
    expect(a.queue.pending).toBe(2); // the sidecar still holds them
    const later = a.issue();
    const r2 = await run();
    expect(r2.hosts["host-a"]).toMatchObject({ pulled: 3, rooted: 1, acked: true, root: { count: 1 } });
    expect(a.queue.pending).toBe(0);
    for (const e of first) expect((await proof(e.leaf)).data.count).toBe(2);
    expect((await proof(later.leaf)).data.count).toBe(1);
  });

  test("a leaf signed by a key the attestation does not bind is rejected, as is every other leaf that does not verify", async () => {
    const a = hosts["host-a"];
    const rogue = EnclaveSigner.generate();
    const good = a.issue();
    const unbound = a.issue({ signer: rogue });
    // A rogue key that claims the bound key's id still fails the signature.
    const forged = a.issue({ signer: rogue, mutate: (e) => ({ ...e, key_id: a.signer.keyId }) });
    const otherAttestation = a.issue({ ref: "ee".repeat(32) });
    const simulated = a.issue({ dev: true });
    const wrongLeaf = a.issue({ mutate: (e) => ({ ...e, leaf: "0x" + "12".repeat(32) }) });
    const r = await run();
    expect(r.hosts["host-a"]).toMatchObject({ pulled: 6, rooted: 1, acked: true, discarded: { unbound_key: 1, bad_signature: 1, other_attestation: 1, simulated: 1, leaf_mismatch: 1 } });
    expect(a.queue.pending).toBe(0); // discarded leaves are dropped too: they can never verify
    const stored = (await h.ctx.db.select().from(hostAnchorLeaves)).map((l) => l.leaf);
    expect(stored).toEqual([good.leaf]);
    for (const bad of [unbound, forged, otherAttestation, simulated]) expect((await h.request(`/api/v1/host-anchors/proof/${bad.leaf}`)).status).toBe(404);
    expect((await h.request(`/api/v1/host-anchors/proof/${wrongLeaf.leaf}`)).status).toBe(404);

    // The same rule as a pure check against the binding the boot document yields.
    const b = bindingFromBootDocument(a.ref, { ...sidecarDocument(ZERO, { bindings: { ...bindingsFor(), receipt_pubkey: a.signer.publicKeyHex } }) });
    expect(b.ok).toBe(false); // that document's quote is not the one the router verified
    expect(checkLeaf({ seq: 1, leaf: unbound.leaf, id: unbound.payload.id, ts: unbound.payload.ts, receipt: unbound }, { attestationRef: a.ref, receiptPublicKey: a.signer.publicKeyHex, receiptKeyId: a.signer.keyId })).toBe("unbound_key");
  });

  test("the receipt key comes only from the quote the router verified", async () => {
    const doc = sidecarDocument(ZERO, { bindings: { ...bindingsFor(), receipt_pubkey: "ab".repeat(32) } });
    const ref = sha(Buffer.from(doc.evidence.quote, "hex"));
    expect(bindingFromBootDocument(ref, doc)).toEqual({ ok: true, binding: { attestationRef: ref, receiptPublicKey: "ab".repeat(32), receiptKeyId: sidecarKeyId("ab".repeat(32)) } });
    expect(bindingFromBootDocument(sha("another quote"), doc)).toMatchObject({ ok: false, reason: "the quote served is not the one the router verified" });
    // Bindings swapped after the quote was taken are not committed in it.
    expect(bindingFromBootDocument(ref, { ...doc, bindings: { ...doc.bindings, receipt_pubkey: "ef".repeat(32) } })).toMatchObject({ ok: false, reason: "the bindings are not committed in the verified quote" });
    expect(bindingFromBootDocument(ref, sidecarDocument(ZERO, { dev: true }))).toMatchObject({ ok: false, reason: "the document carries no hardware quote" });
    // A host that is no longer attested is skipped and its queue is left alone.
    const a = hosts["host-a"];
    a.issue();
    await h.ctx.db.update(providers).set({ attested: false }).where(eq(providers.id, "host-a"));
    try {
      expect((await run()).hosts["host-a"]).toEqual({ skipped: "not attested now" });
      expect(a.queue.pending).toBe(1);
    } finally {
      await h.ctx.db.update(providers).set({ attested: true }).where(eq(providers.id, "host-a"));
    }
  });

  test("a receipt captured from a TDX deployment is rooted under its own attestation reference", async () => {
    real.queue.push(real.receipt);
    const r = await run();
    expect(r.hosts["host-real"]).toMatchObject({ attestation_ref: real.boot.attestation_ref, receipt_key_id: real.boot.receipt_key.key_id, rooted: 1, root: { count: 1, root: real.receipt.leaf } });
    const p = (await proof(real.receipt.leaf)).data;
    expect(p).toMatchObject({ provider: "host-real", attestation_ref: real.boot.attestation_ref, receipt_key: { key_id: real.boot.receipt_key.key_id, public_key: real.boot.bindings.receipt_pubkey }, root: real.receipt.leaf, proof: [], leaf_index: 0 });
    const v = await verifyHostAnchor(real.receipt, p);
    expect(v.valid).toBe(true);
  });

  test("proof round trip: GET by leaf and POST by receipt give the same path, and it verifies", async () => {
    const a = hosts["host-a"];
    const envs = [a.issue(), a.issue(), a.issue(), a.issue(), a.issue()];
    await run();
    for (const [i, env] of envs.entries()) {
      const byLeaf = (await proof(env.leaf)).data;
      const byReceipt = (await (await h.request("/api/v1/host-anchors/proof", { method: "POST", json: { receipt: env } })).json()).data;
      const byBodyLeaf = (await (await h.request("/api/v1/host-anchors/proof", { method: "POST", json: { leaf: env.leaf.toUpperCase().replace("0X", "0x") } })).json()).data;
      expect(byReceipt).toEqual(byLeaf);
      expect(byBodyLeaf).toEqual(byLeaf);
      expect(byLeaf).toMatchObject({ rid: env.payload.id, leaf: env.leaf, leaf_index: i, count: 5, rooted: true });
      expect(MerkleTree.verify(env.leaf as Hex, byLeaf.proof as Hex[], byLeaf.root as Hex)).toBe(true);
    }
    // Unknown, malformed and inconsistent requests.
    expect((await h.request(`/api/v1/host-anchors/proof/0x${"ab".repeat(32)}`)).status).toBe(404);
    expect((await h.request("/api/v1/host-anchors/proof/0x1234")).status).toBe(400);
    expect((await h.request("/api/v1/host-anchors/proof", { method: "POST", json: { receipt: { ...envs[0], leaf: envs[1].leaf } } })).status).toBe(400);
    expect((await h.request("/api/v1/host-anchors/proof", { method: "POST", json: { receipt: { payload: "x" } } })).status).toBe(400);
    expect((await h.request("/api/v1/host-anchors/proof", { method: "POST", json: {} })).status).toBe(400);
  });

  test("the proof endpoint's shape mirrors the router receipt proof", async () => {
    const env = hosts["host-b"].issue();
    await run();
    const res = await h.request(`/api/v1/host-anchors/proof/${env.leaf}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(["anchor_index", "anchored", "attestation_ref", "block", "chain", "contract", "count", "leaf", "leaf_index", "proof", "provider", "provider_id_hash", "receipt_key", "rid", "root", "root_id", "rooted", "status", "tx", "window"].sort());
    expect(data).toMatchObject({ rid: env.payload.id, leaf: env.leaf, rooted: true, anchored: false, status: "local", provider: "host-b", provider_id_hash: providerIdHash("host-b"), attestation_ref: hosts["host-b"].ref, receipt_key: { key_id: hosts["host-b"].signer.keyId, public_key: hosts["host-b"].signer.publicKeyHex }, leaf_index: 0, proof: [], anchor_index: null, tx: null, block: null, chain: h.ctx.cfg.chain.id });
    const w = data.window as { from: string; to: string };
    expect(Date.parse(w.from)).toBeLessThanOrEqual(Date.parse(w.to));
  });

  test("with a chain configured each root is posted with anchorAttested; without one it is kept off chain", async () => {
    const a = hosts["host-a"];
    const b = hosts["host-b"];
    const chain = standInChain();
    const ea = a.issue();
    const eb = b.issue();
    const r = await run(chain.chain);
    expect(chain.calls).toHaveLength(2);
    const rows = await h.ctx.db.select().from(hostAnchors).orderBy(hostAnchors.id);
    expect(chain.calls).toEqual(rows.map((x) => ({ providerId: providerIdHash(x.providerId), root: x.root as Hex, attestationRef: `0x${x.attestationRef}` as Hex })));
    const callA = chain.calls.findIndex((c) => c.providerId === providerIdHash("host-a"));
    const callB = chain.calls.findIndex((c) => c.providerId === providerIdHash("host-b"));
    expect(chain.calls[callA].attestationRef).toBe(`0x${a.ref}`);
    expect(chain.calls[callB].attestationRef).toBe(`0x${b.ref}`);
    expect(r.hosts["host-a"].root).toMatchObject({ status: "confirmed", anchor_index: callA, block: 7_001 + callA });
    expect((await proof(ea.leaf)).data).toMatchObject({ anchored: true, status: "confirmed", anchor_index: callA, block: 7_001 + callA, tx: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect((await proof(eb.leaf)).data).toMatchObject({ anchored: true, anchor_index: callB, block: 7_001 + callB });

    // The chain is down: the root waits as pending (not anchored) and is posted on the next run.
    chain.state.failing = true;
    const later = a.issue();
    expect((await run(chain.chain)).hosts["host-a"].root).toMatchObject({ status: "pending", tx: null });
    expect((await proof(later.leaf)).data).toMatchObject({ anchored: false, status: "pending", tx: null });
    chain.state.failing = false;
    expect((await run(chain.chain)).retried).toBe(1);
    expect((await proof(later.leaf)).data).toMatchObject({ anchored: true, status: "confirmed", anchor_index: 2 });

    // No chain: status local, never a call.
    const local = standInChain({ configured: false });
    const el = b.issue();
    expect((await run(local.chain)).hosts["host-b"].root).toMatchObject({ status: "local", tx: null, block: null, anchor_index: null });
    expect(local.calls).toHaveLength(0);
    expect((await proof(el.leaf)).data).toMatchObject({ anchored: false, status: "local", tx: null, block: null, anchor_index: null });
  });

  test("the client check passes for a real inclusion and fails for everything else", async () => {
    const a = hosts["host-a"];
    const chain = standInChain();
    const envs = [a.issue(), a.issue(), a.issue()];
    await run(chain.chain);
    const env = envs[1];
    const p = (await proof(env.leaf)).data;
    const status = (v: { checks: { id: string; status: string }[] }, id: string) => v.checks.find((c) => c.id === id)?.status;

    // Against the identity the client verified itself, and the root on chain.
    const full = await verifyHostAnchor(env as never, p, { bound: a.bound(), readAnchor: chain.read, requireOnChain: true, providerId: "host-a" });
    expect(full.valid).toBe(true);
    expect(full.onChain).toBe("match");
    for (const id of ["signature", "sidecar.attestation_ref", "host.receipt_key", "host.leaf", "host.attestation_ref", "host.provider", "host.inclusion", "host.onchain"]) expect(status(full, id)).toBe("pass");
    // Without a reader the on-chain step is reported as not checked, never as passed.
    const noReader = await verifyHostAnchor(env as never, p);
    expect(noReader.valid).toBe(true);
    expect(status(noReader, "host.onchain")).toBe("not_checked");

    // Failures.
    const other = envs[0];
    expect((await verifyHostAnchor(other as never, p)).valid).toBe(false); // another receipt's proof
    expect((await verifyHostAnchor(env as never, { ...p, proof: [...p.proof].reverse().map((x, i) => (i === 0 ? "0x" + "00".repeat(32) : x)) })).valid).toBe(false);
    expect((await verifyHostAnchor(env as never, { ...p, root: "0x" + "99".repeat(32) })).valid).toBe(false);
    const tampered = { ...env, payload: { ...env.payload, status: 500 } };
    expect((await verifyHostAnchor(tampered as never, p)).valid).toBe(false);
    expect((await verifyHostAnchor(env as never, p, { providerId: "host-b" })).valid).toBe(false);
    const elsewhere = await verifyHostAnchor(env as never, p, { bound: hosts["host-b"].bound() });
    expect(elsewhere.valid).toBe(false);
    expect(status(elsewhere, "host.receipt_key")).toBe("fail");
    // An on-chain record that differs, or is missing.
    const wrongRoot = async (i: number) => ({ ...(await chain.read(i))!, root: "0x" + "77".repeat(32) });
    const mismatch = await verifyHostAnchor(env as never, p, { readAnchor: wrongRoot });
    expect(mismatch).toMatchObject({ valid: false, onChain: "mismatch" });
    expect((await verifyHostAnchor(env as never, p, { readAnchor: async () => null })).valid).toBe(false);
    // A root kept off chain passes inclusion, but not a caller who requires it on chain.
    const localRun = standInChain({ configured: false });
    const le = a.issue();
    await run(localRun.chain);
    const lp = (await proof(le.leaf)).data;
    expect(await verifyHostAnchor(le as never, lp)).toMatchObject({ valid: true, onChain: "off_chain" });
    expect(await verifyHostAnchor(le as never, lp, { requireOnChain: true })).toMatchObject({ valid: false, onChain: "off_chain" });
  });
});

describe("host anchoring is off by default", () => {
  test("no route and no job unless HOST_ANCHOR_ENABLED", async () => {
    const h = await startRouter({ providers: [] });
    try {
      expect(h.ctx.cfg.hostAnchor).toEqual({ enabled: false, intervalMs: 3_600_000, tokens: {} });
      expect((await h.request(`/api/v1/host-anchors/proof/0x${"ab".repeat(32)}`)).status).toBe(404);
      expect(h.ctx.jobs.status().some((j) => j.name === "host-anchor")).toBe(false);
    } finally {
      await h.close();
    }
  });

  test("configuration: the worker job needs the flag, and tokens must be a JSON object of strings", () => {
    const address = "0x" + "1".repeat(40);
    const worker = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ANCHORER_PRIVATE_KEY: "0x" + "2".repeat(64), WORKER_JOBS: "receipts-anchor,receipt-key-rotation,host-anchor" };
    expect(() => loadConfig(worker)).toThrow(/HOST_ANCHOR_ENABLED/);
    const on = loadConfig({ ...worker, HOST_ANCHOR_ENABLED: "true", HOST_ANCHOR_TOKENS: JSON.stringify({ "host-a": "anchor-token-a" }) });
    expect(on.workerJobs).toContain("host-anchor");
    expect(on.hostAnchor).toEqual({ enabled: true, intervalMs: 3_600_000, tokens: { "host-a": "anchor-token-a" } });
    for (const bad of ["[]", "not json", JSON.stringify({ "host-a": "" }), JSON.stringify({ "host-a": 5 }), JSON.stringify({ "host-a": "two words" })]) expect(() => loadConfig({ ...worker, HOST_ANCHOR_ENABLED: "true", HOST_ANCHOR_TOKENS: bad })).toThrow(/HOST_ANCHOR_TOKENS/);
    expect(() => loadConfig({ ...worker, HOST_ANCHOR_ENABLED: "true", HOST_ANCHOR_INTERVAL_MS: "1000" })).toThrow(/HOST_ANCHOR_INTERVAL_MS/);
  });
});
