import { afterEach, describe, expect, test } from "bun:test";
import { formatReport, runDoctor, type DoctorOptions } from "../src/onboard/doctor.ts";
import { BUN_IMAGE_DIGEST } from "../src/onboard/pins.ts";
import { startServer } from "../src/server.ts";
import { sha256Hex, type Logger } from "../src/util.ts";
import { API_KEY, cleanup, dstackProvider, harness, startUpstream, type Harness } from "./helpers.ts";

afterEach(cleanup);
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

const COMPOSE = `sha256:${"ce".repeat(32)}`;

/** A real sidecar (dstack double for the quote) listening on a loopback port over its own TLS. */
async function sidecar(o: { raw?: Record<string, unknown>; upstreamDown?: boolean; dev?: boolean; logger?: Logger } = {}) {
  const upstream = startUpstream();
  if (o.upstreamDown) upstream.setMode("down");
  const h: Harness = await harness({
    upstream,
    logger: o.logger,
    ...(o.dev ? {} : { provider: dstackProvider({ composeHash: COMPOSE }) }),
    raw: { attestation: { provider: o.dev ? "dev" : "dstack" }, image_digest: BUN_IMAGE_DIGEST, ...(o.raw ?? {}) },
    env: {},
  });
  const server = startServer({ ...h.rt, cfg: { ...h.rt.cfg, server: { ...h.rt.cfg.server, host: "127.0.0.1", port: 0 } } });
  servers.push(server);
  return { h, base: `https://127.0.0.1:${server.port}`, port: server.port as number };
}

const opts = (s: Awaited<ReturnType<typeof sidecar>>, extra: Partial<DoctorOptions> = {}): DoctorOptions => ({
  url: s.base,
  key: API_KEY,
  expected: { modelDigest: s.h.model.digest, modelDigestSource: "the test weights", imageDigest: BUN_IMAGE_DIGEST },
  allowlist: [s.h.model.digest],
  keySha256: sha256Hex(API_KEY),
  ...extra,
});
const status = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)?.status;

describe("a healthy sidecar", () => {
  test("every check passes, the router key is used, and the receipt is verified against the attested key", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s));
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.ok).toBe(true);
    for (const id of ["attest.fetch", "provider.bindings", "provider.report_data", "provider.fresh_quote", "provider.receipt_key", "provider.tls_san", "provider.tls_key", "provider.tls_valid", "expected.model", "expected.image", "digest.allowlist", "healthz", "digest.healthz", "tls.hostname", "auth.required", "auth.key_hash", "auth.key", "receipt"]) {
      expect({ id, status: status(r, id) }).toEqual({ id, status: "pass" });
    }
    // honest about what it cannot do
    expect(status(r, "quote.signature")).toBe("skip");
    expect(status(r, "router.record")).toBe("skip");
    expect(r.notChecked.join(" ")).toMatch(/signature and certificate chain/);
    expect(r.bound?.modelDigest).toBe(s.h.model.digest);
    const text = formatReport(r);
    expect(text).toContain("OK:");
    expect(text).toContain("PASS  a response carries a valid signed receipt");
    expect(text).toContain("SKIP  Intel's signature over the quote");
  });

  test("--no-chat skips the request that costs a generation", async () => {
    const s = await sidecar();
    const before = s.h.upstream.seen.length;
    const r = await runDoctor(opts(s, { chat: false }));
    expect(status(r, "receipt")).toBe("skip");
    expect(s.h.upstream.seen.slice(before).some((x) => x.path === "/v1/chat/completions")).toBe(false);
    expect(r.ok).toBe(true);
  });

  test("without a key nothing that needs one is attempted", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s, { key: undefined }));
    expect(status(r, "auth.key")).toBe("skip");
    expect(status(r, "receipt")).toBe("skip");
    expect(status(r, "auth.required")).toBe("pass");
    expect(r.ok).toBe(true);
  });
});

describe("what it catches", () => {
  test("weights that are not the ones you hashed", async () => {
    const s = await sidecar();
    const wrong = "sha256:" + "ab".repeat(32);
    const r = await runDoctor(opts(s, { expected: { modelDigest: wrong, modelDigestSource: "your weights", imageDigest: BUN_IMAGE_DIGEST } }));
    expect(r.ok).toBe(false);
    expect(status(r, "expected.model")).toBe("fail");
    const detail = r.checks.find((c) => c.id === "expected.model")!.detail;
    expect(detail).toContain(s.h.model.digest);
    expect(detail).toContain(wrong);
  });

  test("a deployment whose allow-list differs from sidecar.yaml", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s, { allowlist: ["sha256:" + "cd".repeat(32)] }));
    expect(status(r, "digest.allowlist")).toBe("fail");
    expect(r.ok).toBe(false);
  });

  test("an image digest other than the one pinned", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s, { expected: { modelDigest: s.h.model.digest, imageDigest: "sha256:" + "ee".repeat(32) } }));
    expect(status(r, "expected.image")).toBe("fail");
  });

  test("a key the sidecar does not know: refused with a reason, and no receipt", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s, { key: "sk-not-the-key", keySha256: undefined }));
    expect(status(r, "auth.key")).toBe("fail");
    expect(r.checks.find((c) => c.id === "auth.key")!.detail).toContain("does not recognise this key");
    expect(status(r, "receipt")).toBe("skip");
    expect(r.ok).toBe(false);
  });

  test("a key file that is not the one sidecar.yaml was written for", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s, { keySha256: "00".repeat(32) }));
    expect(status(r, "auth.key_hash")).toBe("fail");
  });

  test("a sidecar that answers without a key", async () => {
    const s = await sidecar({ raw: { auth: { keys: [], allow_anonymous: true } } });
    const r = await runDoctor(opts(s, { keySha256: undefined }));
    expect(status(r, "auth.required")).toBe("fail");
    expect(r.checks.find((c) => c.id === "auth.required")!.detail).toContain("anyone who finds this address");
    expect(r.ok).toBe(false);
  });

  test("a model server that is down", async () => {
    const s = await sidecar({ upstreamDown: true });
    const r = await runDoctor(opts(s));
    expect(status(r, "healthz")).toBe("fail");
    expect(r.checks.find((c) => c.id === "healthz")!.detail).toContain("model server");
    expect(r.ok).toBe(false);
  });

  test("nothing listening", async () => {
    const s = await sidecar();
    servers.pop()!.stop(true);
    const r = await runDoctor(opts(s));
    expect(r.ok).toBe(false);
    expect(status(r, "attest.fetch")).toBe("fail");
    expect(r.checks.find((c) => c.id === "attest.fetch")!.detail).toContain("Is the sidecar running");
    expect(r.checks.map((c) => c.id)).not.toContain("auth.key");
  });

  test("a URL that is not https, or not a URL", async () => {
    expect((await runDoctor({ url: "http://example.org" })).ok).toBe(false);
    expect((await runDoctor({ url: "nonsense" })).checks[0]).toMatchObject({ id: "endpoint", status: "fail" });
  });

  test("a certificate that does not name the host you reached is a warning, not a failure", async () => {
    const s = await sidecar({ raw: { server: { hostnames: ["only.example.test"] } } });
    const r = await runDoctor(opts(s));
    expect(status(r, "tls.hostname")).toBe("warn");
    expect(r.checks.find((c) => c.id === "tls.hostname")!.detail).toContain("server.hostnames");
    expect(r.ok).toBe(true);
  });
});

describe("simulated evidence", () => {
  test("is refused, and the router key is never sent to it", async () => {
    const seen: string[] = [];
    const logger: Logger = (_l, msg, f) => {
      if (msg === "request") seen.push(String(f?.route));
    };
    const s = await sidecar({ dev: true, logger });
    const r = await runDoctor(opts(s));
    expect(r.ok).toBe(false);
    expect(status(r, "provider.simulated")).toBe("fail");
    expect(status(r, "auth.key")).toBe("skip");
    expect(status(r, "receipt")).toBe("skip");
    expect(r.checks.find((c) => c.id === "auth.key")!.detail).toContain("not sent");
    // The only route that needs a key which was touched is /v1/models, once, by the check that sends none.
    expect(seen.filter((x) => x === "/v1/chat/completions")).toEqual([]);
    expect(seen.filter((x) => x === "models")).toHaveLength(1);
    expect(status(r, "auth.required")).toBe("pass");
  });

  test("is accepted only when asked for, and then labelled", async () => {
    const s = await sidecar({ dev: true, raw: { compose: { hash: COMPOSE } } });
    const r = await runDoctor(opts(s, { allowSimulated: true }));
    expect(status(r, "provider.simulated")).toBe("pass");
    expect(r.checks.find((c) => c.id === "provider.simulated")!.detail).toMatch(/SIMULATED/);
    // the key is sent over the proven certificate, and a receipt that says it is simulated is accepted as such
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.ok).toBe(true);
    for (const id of ["provider.report_data", "provider.fresh_quote", "auth.key", "receipt"]) expect({ id, status: status(r, id) }).toEqual({ id, status: "pass" });
    expect(r.checks.find((c) => c.id === "receipt")!.detail).toMatch(/^SIMULATED/);
  });

  test("a simulated fresh document that does not carry our nonce fails", async () => {
    const s = await sidecar({ dev: true, raw: { compose: { hash: COMPOSE } } });
    const { nodeAttestFetcher } = await import("../../packages/client/src/node.ts");
    const real = nodeAttestFetcher();
    const boot = (await real(`${s.base}/attest`)).json;
    // answers a nonce request with the boot document, as a sidecar that ignores nonces would
    const replay = async (url: string) => ({ ...(await real(url.replace(/\?nonce=.*/, ""))), json: boot });
    const r = await runDoctor(opts(s, { allowSimulated: true, attestFetcher: replay as never }));
    expect(status(r, "provider.fresh_quote")).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "provider.fresh_quote")!.detail).toMatch(/does not carry our nonce/);
  });

  test("a simulated report_data that is not SHA-256(bindings) fails", async () => {
    const s = await sidecar({ dev: true, raw: { compose: { hash: COMPOSE } } });
    const { nodeAttestFetcher } = await import("../../packages/client/src/node.ts");
    const real = nodeAttestFetcher();
    const tamper = async (url: string) => {
      const r = await real(url);
      const doc = JSON.parse(JSON.stringify(r.json));
      if (!doc.evidence.nonce) {
        doc.evidence.report_data = "00".repeat(64);
        doc.evidence.quote = Buffer.from(`dev-simulated:${doc.evidence.report_data}`).toString("hex");
      }
      return { ...r, json: doc };
    };
    const r = await runDoctor(opts(s, { allowSimulated: true, attestFetcher: tamper as never }));
    expect(status(r, "provider.report_data")).toBe("fail");
    expect(r.ok).toBe(false);
  });
});

describe("the router's record", () => {
  const record = (s: Awaited<ReturnType<typeof sidecar>>, over: Record<string, unknown> = {}) => ({
    provider: "demo",
    status: "attested",
    tee: "tdx",
    attested_at: new Date().toISOString(),
    attestation_hash: null,
    verifiers: ["dcap"],
    measurement: { image_digest: BUN_IMAGE_DIGEST, compose_hash: COMPOSE, model_digest: s.h.model.digest, status: "observed", attested_now: true, first_attested_at: "", last_seen_at: "", transparency_log: { found: false, inclusion_verified: false, checkpoint_signature_verified: false }, registry: { address: null, state: "not_submitted", tx_hash: null, registered_at: null } },
    checks: { quote_verified: true, digests_bound_to_quote: true, transparency_log_entry: false, transparency_log_checkpoint_signature: false, registered_on_chain: false },
    not_checked: [],
    ...over,
  });
  const routerFetch = (body: unknown, status = 200) => (async () => new Response(JSON.stringify({ data: body }), { status })) as unknown as typeof fetch;

  test("a record that agrees with the sidecar passes", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s, { router: { url: "https://router.example", providerId: "demo" }, fetchImpl: routerFetch(record(s)) }));
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(status(r, "router.status")).toBe("pass");
    expect(status(r, "router.matches_provider")).toBe("pass");
  });

  test("a record with a different model digest fails", async () => {
    const s = await sidecar();
    const other = record(s);
    other.measurement.model_digest = "sha256:" + "aa".repeat(32);
    const r = await runDoctor(opts(s, { router: { url: "https://router.example", providerId: "demo" }, fetchImpl: routerFetch(other) }));
    expect(status(r, "router.matches_provider")).toBe("fail");
    expect(r.ok).toBe(false);
  });

  test("a router that has not heard of the provider yet is a warning: the application may still be pending", async () => {
    const s = await sidecar();
    const r = await runDoctor(opts(s, { router: { url: "https://router.example", providerId: "demo" }, fetchImpl: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch }));
    expect(status(r, "router.record")).toBe("warn");
    expect(r.checks.map((c) => c.id)).not.toContain("router.status");
    expect(r.ok).toBe(true);
  });
});
