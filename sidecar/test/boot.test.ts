import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { DevAttestationProvider } from "../src/attestation/dev.ts";
import { boot } from "../src/boot.ts";
import { parseConfig } from "../src/config.ts";
import { parseTdxQuote } from "../src/attestation/tdx-quote.ts";
import { reportDataHex } from "../src/reportdata.ts";
import { attestationRefFromSan } from "../src/tls.ts";
import { sha256Hex, silentLogger } from "../src/util.ts";
import { cleanup, DEV_ENV, dstackProvider, harness, makeModel, startUpstream, tmpDir, writeFiles } from "./helpers.ts";

afterEach(cleanup);

const bootFails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return null;
};

describe("boot", () => {
  test("binds the keys and digests into the quote and the certificate SAN (dev evidence)", async () => {
    const h = await harness({ raw: { image_digest: `sha256:${"77".repeat(32)}` } });
    const rt = h.rt;
    expect(rt.dev).toBe(true);
    expect(rt.model).toMatchObject({ digest: h.model.digest, source: "measured", files: 2 });
    expect(rt.bindings.modelDigest).toBe(h.model.digest);
    expect(rt.bindings.imageDigest).toBe(`sha256:${"77".repeat(32)}`);
    expect(rt.bindings.receiptPubkey).toBe(rt.signer.publicKeyHex);
    expect(rt.bindings.tlsPubkey).toBe(rt.tls!.spkiHex);
    expect(rt.bootEvidence.reportData).toBe(reportDataHex(rt.bindings));
    // The certificate carries the hash of the quote.
    expect(rt.attestationRef).toBe(sha256Hex(Buffer.from(rt.bootEvidence.quote, "hex")));
    const cert = new X509Certificate(rt.tls!.certPem);
    const san = cert.subjectAltName!.split(", ").map((s) => s.replace(/^DNS:/, "")).find((s) => attestationRefFromSan(s));
    expect(attestationRefFromSan(san!)).toBe(rt.attestationRef);
  });

  test("with a hardware-shaped provider the quote's own report data is the bindings digest", async () => {
    const composeHash = `sha256:${"ce".repeat(32)}`;
    const h = await harness({ provider: dstackProvider({ composeHash }), raw: { attestation: { provider: "dstack" } }, env: {} });
    expect(h.rt.dev).toBe(false);
    expect(h.rt.composeHash).toEqual({ value: composeHash, source: "platform" });
    const fields = parseTdxQuote(Buffer.from(h.rt.bootEvidence.quote, "hex"));
    expect(fields.reportData).toBe(reportDataHex(h.rt.bindings));
    expect(new X509Certificate(h.rt.tls!.certPem).subjectAltName).not.toContain("dev-simulated");
  });

  test("keys are fresh for every boot", async () => {
    const model = await makeModel();
    const upstream = startUpstream();
    const a = await harness({ model, upstream });
    const b = await harness({ model, upstream });
    expect(a.rt.signer.publicKeyHex).not.toBe(b.rt.signer.publicKeyHex);
    expect(a.rt.tls!.spkiHex).not.toBe(b.rt.tls!.spkiHex);
    expect(a.rt.attestationRef).not.toBe(b.rt.attestationRef);
  });

  test("refuses to start when the served weights are not on the allow-list", async () => {
    const model = await makeModel();
    const other = await makeModel({ "w.bin": "different weights" });
    expect(await bootFails(harness({ model, raw: { allowlist: { model_digests: [other.digest] } } }))).toBe("MODEL_DIGEST_NOT_ALLOWED");
  });

  test("refuses to start with an empty allow-list, before hashing anything", async () => {
    const model = await makeModel();
    let hashed = false;
    const t0 = Date.now();
    const code = await bootFails(
      harness({ model, raw: { model: { path: join(model.dir, "does-not-exist") }, allowlist: {} } }).then(() => {
        hashed = true;
      }),
    );
    expect(code).toBe("MODEL_ALLOWLIST_EMPTY"); // not MODEL_UNREADABLE: the list is checked first
    expect(hashed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("a changed weight file changes the digest and the allow-list rejects it", async () => {
    const model = await makeModel();
    writeFiles(model.dir, { "weights.safetensors": "tampered" });
    expect(await bootFails(harness({ model }))).toBe("MODEL_DIGEST_NOT_ALLOWED");
  });

  test("a declared digest that disagrees with the weights is refused; a declared-only digest is labelled", async () => {
    const model = await makeModel();
    expect(await bootFails(harness({ model, raw: { model: { path: model.dir, digest: `sha256:${"00".repeat(32)}` } } }))).toBe("MODEL_DIGEST_MISMATCH");
    const h = await harness({ model, raw: { model: { digest: model.digest } } });
    expect(h.rt.model.source).toBe("declared");
    const res = await h.call("/attest", { key: null });
    expect((await res.json()).model.digest_source).toBe("declared");
  });

  test("compose hash: sources must agree, and a configured allow-list is enforced", async () => {
    const model = await makeModel();
    const dir = tmpDir();
    writeFiles(dir, { "app-compose.json": '{"services":{"vllm":{}}}' });
    const file = join(dir, "app-compose.json");
    const fileHash = `sha256:${sha256Hex(Buffer.from('{"services":{"vllm":{}}}'))}`;
    const allowlist = (compose: string[]) => ({ model_digests: [model.digest], compose_hashes: compose });
    const h = await harness({ model, raw: { compose: { file }, allowlist: allowlist([fileHash]) } });
    expect(h.rt.composeHash).toEqual({ value: fileHash, source: "compose_file" });
    // The same file plus a different configured hash is a conflict.
    expect(await bootFails(harness({ model, raw: { compose: { file, hash: `sha256:${"99".repeat(32)}` } } }))).toBe("COMPOSE_HASH_CONFLICT");
    // A platform hash that differs from the file too.
    expect(await bootFails(harness({ model, provider: dstackProvider({ composeHash: `sha256:${"98".repeat(32)}` }), raw: { compose: { file } }, env: {} }))).toBe("COMPOSE_HASH_CONFLICT");
    // Not on the allow-list.
    expect(await bootFails(harness({ model, raw: { compose: { hash: `sha256:${"99".repeat(32)}` }, allowlist: allowlist([fileHash]) } }))).toBe("COMPOSE_HASH_NOT_ALLOWED");
    // An allow-list but nothing to check it against.
    expect(await bootFails(harness({ model, raw: { allowlist: allowlist([fileHash]) } }))).toBe("COMPOSE_HASH_MISSING");
    expect(await bootFails(harness({ model, raw: { compose: { file: join(dir, "missing.json") } } }))).toBe("COMPOSE_UNREADABLE");
  });

  test("a classifier that is switched on without its settings is refused, not skipped", async () => {
    expect(await bootFails(harness({ raw: { classifier: { enabled: true } } }))).toBe("BAD_CONFIG");
    // Complete settings but no allow-list entry for its weights: also refused (see classifier.test.ts for the rest).
    const model = await makeModel();
    const raw = { classifier: { enabled: true, base_url: "http://127.0.0.1:1", model: { digest: `sha256:${"ab".repeat(32)}`, served_name: "cls" } } };
    expect(await bootFails(harness({ model, raw }))).toBe("CLASSIFIER_ALLOWLIST_EMPTY");
  });

  test("tls off leaves the TLS binding empty and says so", async () => {
    const h = await harness({ raw: { server: { tls: "off" } } });
    expect(h.rt.tls).toBeNull();
    expect(h.rt.bindings.tlsPubkey).toBe("");
    const doc = await (await h.call("/attest", { key: null })).json();
    expect(doc.tls).toBeNull();
    expect(doc.attestation_san).toBeNull();
  });
});

describe("dev attestation is refused unless enabled", () => {
  test("no flag, no boot: from configuration", async () => {
    const model = await makeModel();
    const cfg = parseConfig({ model: { path: model.dir }, allowlist: { model_digests: [model.digest] }, attestation: { provider: "dev" }, auth: { allow_anonymous: true } }, {});
    expect(await bootFails(boot(cfg, { env: {}, logger: silentLogger }))).toBe("DEV_ATTESTATION_DISABLED");
    expect(await bootFails(boot(cfg, { env: { SIDECAR_DEV_ATTESTATION: "yes" }, logger: silentLogger }))).toBe("DEV_ATTESTATION_DISABLED");
  });

  test("no flag, no boot: even with an injected dev provider", async () => {
    const model = await makeModel();
    const cfg = parseConfig({ model: { path: model.dir }, allowlist: { model_digests: [model.digest] }, attestation: { provider: "dev" }, auth: { allow_anonymous: true } }, DEV_ENV);
    expect(await bootFails(boot(cfg, { env: {}, logger: silentLogger, provider: new DevAttestationProvider() }))).toBe("DEV_ATTESTATION_DISABLED");
  });

  test("dev mode is marked on every surface", async () => {
    const h = await harness();
    const surfaces = [await h.call("/healthz", { key: null }), await h.call("/attest", { key: null }), await h.call("/.well-known/anyroute-sidecar.json", { key: null }), await h.chat({ model: "ok", messages: [] }), await h.call("/nope", { key: null })];
    for (const r of surfaces) expect(r.headers.get("x-anyroute-attestation")).toBe("dev-simulated");
    expect((await surfaces[0].json()).dev).toBe(true);
    const attest = await surfaces[1].json();
    expect(attest.dev).toBe(true);
    expect(attest.evidence.dev).toBe(true);
    expect(attest.evidence.format).toBe("dev-simulated");
    expect(attest.warning).toContain("SIMULATED");
    expect((await surfaces[2].json()).dev).toBe(true);
  });

  test("hardware mode carries no dev marker", async () => {
    const h = await harness({ provider: dstackProvider(), raw: { attestation: { provider: "dstack" } }, env: {} });
    const r = await h.call("/attest", { key: null });
    expect(r.headers.get("x-anyroute-attestation")).toBeNull();
    const doc = await r.json();
    expect(doc.dev).toBe(false);
    expect(doc.warning).toBeUndefined();
    expect(doc.evidence.format).toBe("tdx-quote-v4");
    expect(doc.checks).toEqual({ report_data_matches_quote: true, quote_signature_verified_by_sidecar: false });
  });
});

describe("router record cross-check", () => {
  const record = (digests: string[]) => (async () => Response.json({ provider_id: "p1", measurements: { model_digest: digests[0], allowed_model_digests: digests } })) as unknown as typeof fetch;

  test("passes when the router's record names the served digest", async () => {
    const model = await makeModel();
    let asked = "";
    const fetchImpl = (async (url: URL | string) => {
      asked = String(url);
      return Response.json({ measurements: { allowed_model_digests: [model.digest] } });
    }) as unknown as typeof fetch;
    const h = await harness({ model, fetchImpl, raw: { router: { url: "https://router.example", provider_id: "p1" } } });
    expect(h.rt.routerChecked).toBe(true);
    expect(asked).toBe("https://router.example/api/v1/attestation/p1");
  });

  test("reads the router's own response envelope ({ data: { measurement: {...} } })", async () => {
    const model = await makeModel();
    const fetchImpl = (async () =>
      Response.json({ data: { provider: "p1", status: "attested", measurement: { image_digest: `0x${"11".repeat(32)}`, model_digest: `0x${model.digest.replace(/^sha256:/, "")}`, status: "ready" } } })) as unknown as typeof fetch;
    const raw = { router: { url: "https://router.example", provider_id: "p1" } };
    const h = await harness({ model, fetchImpl, raw });
    expect(h.rt.routerChecked).toBe(true);
    const other = (async () => Response.json({ data: { measurement: { model_digest: `0x${"ee".repeat(32)}` } } })) as unknown as typeof fetch;
    expect(await bootFails(harness({ model, raw, fetchImpl: other }))).toBe("ROUTER_DIGEST_MISMATCH");
    const none = (async () => Response.json({ data: { status: "unverified", measurement: null } })) as unknown as typeof fetch;
    expect(await bootFails(harness({ model, raw, fetchImpl: none }))).toBe("ROUTER_RECORD_UNRECOGNISED");
  });

  test("refuses on a mismatch, an unrecognised record, and (fail closed) an unreachable router", async () => {
    const model = await makeModel();
    const raw = { router: { url: "https://router.example", provider_id: "p1" } };
    expect(await bootFails(harness({ model, raw, fetchImpl: record([`sha256:${"ee".repeat(32)}`]) }))).toBe("ROUTER_DIGEST_MISMATCH");
    expect(await bootFails(harness({ model, raw, fetchImpl: (async () => Response.json({ hello: "world" })) as unknown as typeof fetch }))).toBe("ROUTER_RECORD_UNRECOGNISED");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await bootFails(harness({ model, raw, fetchImpl: down }))).toBe("ROUTER_UNREACHABLE");
    const open = await harness({ model, raw: { router: { ...raw.router, fail_closed: false } }, fetchImpl: down });
    expect(open.rt.routerChecked).toBe(false);
  });

  test("the router URL must be https (loopback excepted)", async () => {
    const model = await makeModel();
    expect(await bootFails(harness({ model, raw: { router: { url: "http://router.example", provider_id: "p1" } } }))).toBe("BAD_CONFIG");
  });
});
