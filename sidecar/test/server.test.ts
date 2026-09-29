import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:tls";
import { join } from "node:path";
import { parseTdxQuote } from "../src/attestation/tdx-quote.ts";
import { hashModelPath } from "../src/digest.ts";
import { bindingsDigest } from "../src/reportdata.ts";
import { decodeReceiptHeader, verifyReceipt } from "../src/receipts.ts";
import { startServer } from "../src/server.ts";
import { attestationRefFromSan } from "../src/tls.ts";
import { sha256Hex } from "../src/util.ts";
import { API_KEY, cleanup, dstackProvider, harness, makeModel, startUpstream, tmpDir, writeFiles, type Harness } from "./helpers.ts";

afterEach(cleanup);

/** Peer certificate as presented on the wire, read without trusting it. */
function peerCert(port: number): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, servername: "localhost" }, () => {
      const raw = s.getPeerCertificate().raw;
      s.end();
      resolve(new X509Certificate(raw));
    });
    s.on("error", reject);
  });
}

async function serving(h: Harness) {
  const server = startServer({ ...h.rt, cfg: { ...h.rt.cfg, server: { ...h.rt.cfg.server, host: "127.0.0.1", port: 0 } } });
  const port = server.port as number;
  return { server, port, base: `https://127.0.0.1:${port}`, stop: () => server.stop(true) };
}

describe("over real TLS", () => {
  test("a client that pins the certificate can check it against the evidence at /attest", async () => {
    const h = await harness({ provider: dstackProvider({ composeHash: `sha256:${"ce".repeat(32)}` }), raw: { attestation: { provider: "dstack" } }, env: {} });
    const s = await serving(h);
    try {
      const tls = { ca: h.rt.tls!.certPem };
      // 1. The connection verifies against the pinned certificate (chain, validity and host name).
      const attest = await (await fetch(`${s.base}/attest`, { tls })).json();
      // 2. The SAN on the wire carries the hash of the quote served at /attest.
      const cert = await peerCert(s.port);
      const sans = cert.subjectAltName!.split(", ").map((x) => x.replace(/^DNS:/, ""));
      const refs = sans.map(attestationRefFromSan).filter(Boolean);
      expect(refs).toEqual([attest.attestation_ref]);
      expect(sha256Hex(Buffer.from(attest.evidence.quote, "hex"))).toBe(attest.attestation_ref);
      // 3. The certificate's key is the TLS key the quote binds.
      expect(cert.publicKey.export({ type: "spki", format: "der" }).toString("hex")).toBe(attest.bindings.tls_pubkey);
      // 4. The quote's report data is sha256(canonical bindings) followed by a zero nonce.
      const rd = parseTdxQuote(Buffer.from(attest.evidence.quote, "hex")).reportData;
      expect(rd).toBe(attest.evidence.report_data);
      expect(rd.slice(0, 64)).toBe(Buffer.from(bindingsDigest(h.rt.bindings)).toString("hex"));
      expect(rd.slice(64)).toBe("00".repeat(32));
      // 5. Receipts verify against the key in the bindings.
      const res = await fetch(`${s.base}/v1/chat/completions`, { tls, method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: "ok", messages: [] }) });
      expect(res.status).toBe(200);
      const env = decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);
      expect(verifyReceipt(env, attest.bindings.receipt_pubkey)).toBe(true);
      expect(env.payload.attestation_ref).toBe(attest.attestation_ref);
      expect(attest.model.digest).toBe(h.model.digest);
    } finally {
      s.stop();
    }
  });

  test("a client that does not have the certificate cannot connect", async () => {
    const h = await harness();
    const s = await serving(h);
    try {
      expect(fetch(`${s.base}/healthz`)).rejects.toThrow();
    } finally {
      s.stop();
    }
  });

  test("streams over TLS end with the receipt event", async () => {
    const h = await harness();
    const s = await serving(h);
    try {
      const res = await fetch(`${s.base}/v1/chat/completions`, {
        tls: { ca: h.rt.tls!.certPem },
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "ok", stream: true, messages: [] }),
      });
      const text = await res.text();
      expect(text).toContain("data: [DONE]");
      expect(text.trimEnd().split("\n").slice(-2)[0]).toBe("event: anyroute.receipt");
    } finally {
      s.stop();
    }
  });
});

describe("endpoints", () => {
  test("/healthz reports readiness and the state of the model server", async () => {
    const h = await harness();
    const ok = await h.call("/healthz", { key: null });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", upstream: "ok", model_digest: h.model.digest, attestation: { kind: "dev", ref: h.rt.attestationRef } });
    const down = await harness();
    down.upstream.stop();
    const res = await down.call("/healthz", { key: null });
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("degraded");
  });

  test("/attest with a nonce returns a fresh quote bound to it, and is rate limited", async () => {
    const h = await harness({ provider: dstackProvider(), raw: { attestation: { provider: "dstack", fresh_quotes_per_minute: 2 } }, env: {} });
    const nonce = "5a".repeat(32);
    const doc = await (await h.call(`/attest?nonce=${nonce}`, { key: null })).json();
    expect(doc.evidence.boot).toBe(false);
    expect(doc.evidence.nonce).toBe(nonce);
    expect(doc.evidence.report_data.slice(64)).toBe(nonce);
    expect(parseTdxQuote(Buffer.from(doc.evidence.quote, "hex")).reportData).toBe(doc.evidence.report_data);
    expect(doc.evidence.report_data.slice(0, 64)).toBe(Buffer.from(bindingsDigest(h.rt.bindings)).toString("hex"));
    expect(doc.attestation_ref).toBe(h.rt.attestationRef); // the reference stays the boot quote's
    expect((await h.call("/attest?nonce=zz", { key: null })).status).toBe(400);
    expect((await h.call(`/attest?nonce=${nonce}`, { key: null })).status).toBe(200);
    const limited = await h.call(`/attest?nonce=${nonce}`, { key: null });
    expect(limited.status).toBe(429);
    // The boot quote is always available.
    expect((await (await h.call("/attest", { key: null })).json()).evidence.boot).toBe(true);
  });

  test("the well-known document describes how to verify receipts", async () => {
    const h = await harness({ raw: { royalty: { recipient: "0x" + "12".repeat(20) }, image_digest: `sha256:${"77".repeat(32)}` } });
    const doc = await (await h.call("/.well-known/anyroute-sidecar.json", { key: null })).json();
    expect(doc).toMatchObject({
      type: "anyroute.sidecar",
      receipts: { alg: "Ed25519", public_key: h.rt.signer.publicKeyHex, header: "x-anyroute-receipt", sse_event: "anyroute.receipt" },
      model_digest: h.model.digest,
      image_digest: `sha256:${"77".repeat(32)}`,
      royalty_recipient: "0x" + "12".repeat(20),
      tls_spki_sha256: h.rt.tls!.spkiSha256,
      classifier: { enabled: false },
    });
    expect(doc.endpoints.attest).toBe("/attest");
  });

  test("unknown paths are 404 and wrong methods are 405", async () => {
    const h = await harness();
    expect((await h.call("/nope", { key: null })).status).toBe(404);
    expect((await h.call("/attest", { key: null, method: "POST" })).status).toBe(405);
    expect((await h.call("/v1/embeddings", { method: "GET" })).status).toBe(405);
  });

  test("the anchor endpoints are off without a token and serve leaves with one", async () => {
    const off = await harness();
    expect((await off.call("/anchor/leaves", { key: null })).status).toBe(404);
    const h = await harness({ env: { SIDECAR_ANCHOR_TOKEN: "anchor-secret" } });
    const anchor = (path: string, init: RequestInit = {}, token = "anchor-secret") => h.call(path, { ...init, key: null, headers: { authorization: `Bearer ${token}` } });
    expect((await anchor("/anchor/leaves", {}, "wrong")).status).toBe(401);
    expect((await h.call("/anchor/leaves", { key: API_KEY })).status).toBe(401); // an API key is not the anchor token
    for (let i = 0; i < 3; i++) await h.chat({ model: "ok", messages: [] });
    const page = await (await anchor("/anchor/leaves?after=1&limit=5")).json();
    expect(page.head).toBe(3);
    expect(page.leaves.map((l: { seq: number }) => l.seq)).toEqual([2, 3]);
    for (const l of page.leaves) expect(verifyReceipt(l.receipt, h.rt.signer.publicKeyHex)).toBe(true);
    const ack = await anchor("/anchor/ack", { method: "POST", body: JSON.stringify({ through_seq: 2 }) });
    expect(await ack.json()).toEqual({ removed: 2, pending: 1 });
    expect((await anchor("/anchor/ack", { method: "POST", body: "{}" })).status).toBe(400);
  });
});

describe("the command line", () => {
  const MAIN = join(import.meta.dir, "..", "src", "main.ts");
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [MAIN, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
    });

  test("`digest` prints the model digest used for the allow-list", async () => {
    const model = await makeModel();
    const r = await run(["digest", model.dir], {});
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(model.digest);
    expect((await hashModelPath(model.dir)).digest).toBe(model.digest);
  });

  test("`serve` refuses to start on dev attestation without the flag, and on a digest that is not allowed", async () => {
    const model = await makeModel();
    const dir = tmpDir();
    const cfg = (digest: string) => `
model:
  path: ${model.dir}
allowlist:
  model_digests: ["${digest}"]
attestation:
  provider: dev
auth:
  allow_anonymous: true
`;
    writeFiles(dir, { "ok.yaml": cfg(model.digest), "bad.yaml": cfg(`sha256:${"00".repeat(32)}`) });
    const noFlag = await run(["serve", "--config", join(dir, "ok.yaml")], {});
    expect(noFlag.code).toBe(1);
    expect(noFlag.err).toContain("DEV_ATTESTATION_DISABLED");
    const notAllowed = await run(["serve", "--config", join(dir, "bad.yaml")], { SIDECAR_DEV_ATTESTATION: "true" });
    expect(notAllowed.code).toBe(1);
    expect(notAllowed.err).toContain("MODEL_DIGEST_NOT_ALLOWED");
  });

  test("`serve` starts, answers, and shuts down on SIGTERM", async () => {
    const model = await makeModel();
    const up = startUpstream();
    const dir = tmpDir();
    writeFiles(dir, {
      "sidecar.yaml": `
server:
  tls: "off"
  host: 127.0.0.1
upstream:
  base_url: ${up.url}
model:
  path: ${model.dir}
allowlist:
  model_digests: ["${model.digest}"]
attestation:
  provider: dev
auth:
  allow_anonymous: true
`,
    });
    const child = spawn(process.execPath, [MAIN, "serve", "--config", join(dir, "sidecar.yaml")], { env: { PATH: process.env.PATH ?? "", SIDECAR_DEV_ATTESTATION: "true", SIDECAR_PORT: "0" } });
    let err = "";
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no listening line: ${err}`)), 15_000);
      child.stderr.on("data", (d) => {
        err += d;
        const m = /"msg":"listening".*?"port":(\d+)/.exec(err);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", () => reject(new Error(`exited early: ${err}`)));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ok", messages: [] }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-anyroute-attestation")).toBe("dev-simulated");
      const env = decodeReceiptHeader(res.headers.get("x-anyroute-receipt")!);
      const doc = await (await fetch(`http://127.0.0.1:${port}/attest`)).json();
      expect(verifyReceipt(env, doc.receipt_key.public_key)).toBe(true);
      expect(err).toContain("DEV ATTESTATION");
    } finally {
      const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    }
  });
});
