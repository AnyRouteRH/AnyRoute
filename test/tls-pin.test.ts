import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { attestations, kv, providers } from "../src/db/schema.ts";
import { providerFetch } from "../src/providers/network.ts";
import { describePeerCertificate, loadTlsPin } from "../src/providers/tls-pin.ts";
import { callUpstream } from "../src/providers/upstream.ts";
import { attestProvider } from "../src/services/attestor.ts";
import { createTlsIdentity, generateTlsKey } from "../sidecar/src/tls.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { bindingsFor, sidecarDocument } from "./measurement-fixtures.ts";

// Quote-pinned TLS: a sidecar's self-signed certificate is accepted only when the quote it names verifies and binds
// its key, and from then on the provider's connections accept only that certificate.

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ZERO = "00".repeat(32);

type Sidecar = { url: string; hits: string[]; spkiHex: string; stop: () => void; bootQuote: string };

/**
 * A sidecar double on https://127.0.0.1. By default everything is consistent: the TLS key is bound in the bindings,
 * the boot and fresh quotes commit to them, and the certificate names sha256(boot quote).
 *   sanRef "wrong"      the certificate names some other hash
 *   sanRef "ambiguous"  the certificate carries two attestation names, so it names none
 *   boundKey "other"    the quotes bind a different TLS key than the certificate's
 *   dev                 the endpoint serves simulated evidence
 */
function sidecar(o: { sanRef?: "wrong" | "ambiguous"; boundKey?: "other"; dev?: boolean } = {}): Sidecar {
  const tls = generateTlsKey();
  const spkiHex = tls.spkiDer.toString("hex");
  const bindings = { ...bindingsFor(), tls_pubkey: o.boundKey === "other" ? generateTlsKey().spkiDer.toString("hex") : spkiHex };
  const boot = sidecarDocument(ZERO, { bindings });
  const bootQuote = boot.evidence.quote;
  const ref = o.sanRef === "wrong" ? sha(Buffer.from("some other quote")) : sha(Buffer.from(bootQuote, "hex"));
  const extra = o.sanRef === "ambiguous" ? [`${"cd".repeat(16)}.${"cd".repeat(16)}.attest.anyroute`] : [];
  const id = createTlsIdentity(tls.privateKey, { attestationRef: ref, hostnames: ["localhost", ...extra] });
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: id.keyPem, cert: id.certPem },
    fetch: async (req) => {
      const u = new URL(req.url);
      hits.push(u.pathname + u.search);
      if (u.pathname === "/attest") {
        const nonce = u.searchParams.get("nonce");
        if (o.dev) return Response.json({ ...sidecarDocument(nonce ?? ZERO, { bindings, dev: true }) });
        return Response.json(nonce ? { ...sidecarDocument(nonce, { bindings }), attestation_ref: ref } : { ...boot, attestation_ref: ref });
      }
      if (u.pathname === "/v1/chat/completions") return Response.json({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "pinned" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      if (u.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "m" }] });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `https://127.0.0.1:${server.port}`, hits, spkiHex, bootQuote, stop: () => server.stop(true) };
}

describe("quote-pinned TLS", () => {
  let h: Harness;
  let dcap: ReturnType<typeof Bun.serve>;
  const rejected = new Set<string>();
  const servers: Sidecar[] = [];
  const PID = "tee";
  const serve = (o: Parameters<typeof sidecar>[0] = {}) => {
    const s = sidecar(o);
    servers.push(s);
    return s;
  };
  const point = async (s: Sidecar) => {
    await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationUrl: `${s.url}/attest`, baseUrl: `${s.url}/v1` }).where(eq(providers.id, PID));
    const [row] = await h.ctx.db.select().from(providers).where(eq(providers.id, PID));
    return row;
  };
  const attest = async (s: Sidecar) => (await attestProvider(h.ctx, await point(s))) as { ok: boolean; reason?: string; tls_pin?: { spki_sha256: string; attestation_ref: string } };

  beforeAll(async () => {
    dcap = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const { quote } = (await req.json()) as { quote: string };
        return Response.json(rejected.has(quote) ? { verified: false, tcb_status: "Revoked" } : { verified: true });
      },
    });
    h = await startRouter({ providers: [{ id: PID, name: "TEE", models: [MODELS.qwen] }], env: { TDX_VERIFIER_URL: `http://127.0.0.1:${dcap.port}/verify` } });
  });
  afterAll(async () => {
    for (const s of servers) s.stop();
    dcap.stop(true);
    await h.close();
  });
  beforeEach(async () => {
    rejected.clear();
    await h.ctx.db.delete(attestations);
    await h.ctx.db.delete(kv).where(eq(kv.key, `tls-pin:${PID}`));
  });

  test("a consistent sidecar is attested and its certificate pinned", async () => {
    const s = serve();
    const r = await attest(s);
    expect(r).toMatchObject({ ok: true });
    const pin = await loadTlsPin(h.ctx.db, PID);
    expect(pin?.spkiSha256).toBe(sha(Buffer.from(s.spkiHex, "hex")));
    expect(pin?.attestationRef).toBe(sha(Buffer.from(s.bootQuote, "hex")));
    expect(r.tls_pin).toEqual({ spki_sha256: pin!.spkiSha256, attestation_ref: pin!.attestationRef });
    // Both quotes were fetched over the pinned connection, and both went to the verifier.
    expect(s.hits.filter((x) => x.startsWith("/attest"))).toHaveLength(2);
    const [row] = await h.ctx.db.select().from(providers).where(eq(providers.id, PID));
    expect(row.attested).toBe(true);
    const view = (await (await h.request(`/api/v1/attestation/${PID}`)).json()) as { data: { status: string; tls_pin: unknown } };
    expect(view.data).toMatchObject({ status: "attested", tls_pin: { spki_sha256: pin!.spkiSha256, attestation_ref: pin!.attestationRef } });
  });

  test("a certificate whose attestation name is not sha256 of the served quote is refused", async () => {
    const r = await attest(serve({ sanRef: "wrong" }));
    expect(r).toMatchObject({ ok: false, reason: "the certificate's attestation reference is not the hash of the quote the endpoint serves" });
    expect(await loadTlsPin(h.ctx.db, PID)).toBeNull();
  });

  test("a certificate for a key the quote does not bind is refused", async () => {
    const r = await attest(serve({ boundKey: "other" }));
    expect(r).toMatchObject({ ok: false, reason: "the certificate's key is not the TLS key the quote binds" });
    expect(await loadTlsPin(h.ctx.db, PID)).toBeNull();
  });

  test("a certificate naming a quote that does not verify is refused", async () => {
    const s = serve();
    rejected.add(s.bootQuote);
    const r = await attest(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("the quote the certificate names did not verify");
    expect(await loadTlsPin(h.ctx.db, PID)).toBeNull();
  });

  test("any other self-signed endpoint is still refused", async () => {
    // A certificate with two attestation names names none: it gets the ordinary CA check, which it fails.
    const ambiguous = serve({ sanRef: "ambiguous" });
    const r = await attest(ambiguous);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("attestation endpoint unreachable");
    expect(ambiguous.hits).toHaveLength(0);
    // Simulated evidence cannot vouch for a certificate, even where dev attestation is allowed.
    const dev = await attest(serve({ dev: true }));
    expect(dev).toMatchObject({ ok: false, reason: "a self-signed endpoint must prove its certificate with a hardware TDX quote" });
    expect(await loadTlsPin(h.ctx.db, PID)).toBeNull();
    const one = createTlsIdentity(generateTlsKey().privateKey, { attestationRef: "ab".repeat(32) });
    expect(describePeerCertificate(one.certDer).attestationRef).toBe("ab".repeat(32));
  });

  test("after attestation, calls go only to the attested key", async () => {
    const good = serve();
    expect((await attest(good)).ok).toBe(true);
    await h.ctx.catalog.refresh();
    const candidate = h.ctx.catalog.offers(MODELS.qwen.slug).find((c) => c.providerId === PID)!;
    expect(candidate.provider.tlsPin?.spkiSha256).toBe(sha(Buffer.from(good.spkiHex, "hex")));
    const call = (c: typeof candidate) =>
      callUpstream({ candidate: c, path: "/chat/completions", body: { model: "m", messages: [{ role: "user", content: "hi" }] }, stream: false, signal: new AbortController().signal, timeoutMs: 10_000, firstTokenTimeoutMs: 10_000, production: false });
    const ok = await call(candidate);
    expect(ok).toMatchObject({ ok: true });
    expect(good.hits).toContain("/v1/chat/completions");
    // The same provider now answering with another key (a restarted sidecar, or anyone else) gets nothing.
    const impostor = serve();
    const moved = { ...candidate, provider: { ...candidate.provider, baseUrl: `${impostor.url}/v1` } };
    const refused = await call(moved);
    expect(refused).toMatchObject({ ok: false, errorKind: "connection" });
    expect(impostor.hits).toHaveLength(0);
    // Probes and discovery use the same pin.
    await expect(providerFetch(`${impostor.url}/v1/models`, {}, { production: false, allowDevelopmentMockLoopback: true, tlsPin: candidate.provider.tlsPin })).rejects.toThrow();
    const models = await providerFetch(`${good.url}/v1/models`, {}, { production: false, allowDevelopmentMockLoopback: true, tlsPin: candidate.provider.tlsPin });
    expect(models.status).toBe(200);
    // Without a pin, the self-signed endpoint is not reachable at all.
    await expect(providerFetch(`${good.url}/v1/models`, {}, { production: false, allowDevelopmentMockLoopback: true })).rejects.toThrow();
  });

  test("a new key replaces the pin only through a new attestation, and a failed one keeps the old pin", async () => {
    const first = serve();
    expect((await attest(first)).ok).toBe(true);
    const pinned = (await loadTlsPin(h.ctx.db, PID))!.spkiSha256;
    const bad = serve({ boundKey: "other" });
    expect((await attest(bad)).ok).toBe(false);
    expect((await loadTlsPin(h.ctx.db, PID))!.spkiSha256).toBe(pinned);
    const restarted = serve();
    expect((await attest(restarted)).ok).toBe(true);
    expect((await loadTlsPin(h.ctx.db, PID))!.spkiSha256).toBe(sha(Buffer.from(restarted.spkiHex, "hex")));
  });
});
