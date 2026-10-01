import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generations, holds, ledger, providerDisclosure, providers } from "../src/db/schema.ts";
import { agreementCursor, agreementJury, agreementProjection } from "../src/agreements/schema.ts";
import { agreementScope, type Agreement } from "../src/agreements/state.ts";
import { callInternalJuryModel, juryCandidates, selectableJuryModels } from "../src/agreements/internal-transport.ts";
import { runAgreementJury, type Vote } from "../src/agreements/jury.ts";
import { postAgreementRuling, type RulingTransport } from "../src/agreements/posting.ts";
import { JURY_RUBRIC } from "../src/agreements/verdict.ts";
import { sha256 } from "../src/lib/util.ts";
import { keysetDigest, type AciGateway } from "../src/providers/aci.ts";
import { CLAIMS_OK, keyset, RECEIPT_KEY, OTHER_KEY, signedReceipt } from "./aci-fixtures.ts";
import { createTlsIdentity, generateTlsKey } from "../sidecar/src/tls.ts";
import { startRouter, type Harness } from "./helpers.ts";

// Fixture attestation rows exercise selection; these are not live hardware quote verification.
const addr = (n: number) => `0x${n.toString().repeat(40)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const text = JSON.stringify({ verdict: "pay", payee_bps: 10000, reason: "Terms fulfilled" });
const model = (n: number) => ({ id: `upstream-${n}`, slug: `jury/m${n}`, prompt: "0.000001", completion: "0.000002" });
const env = { AGENT_AGREEMENTS_ENABLED: "true", AGREEMENT_JURY_INTERNAL_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: addr(4), DISPUTE_ORACLE_ADDRESS: addr(5), AGREEMENT_EVIDENCE_WINDOW_SECONDS: "60" };

describe("internal agreement jury with PG and Redis", () => {
  let h: Harness;
  const router = () => { throw new Error("internal transport must not call the customer router"); };
  beforeAll(async () => {
    h = await startRouter({ env, providers: [
      ...[1, 2, 3].map(n => ({ id: `p${n}`, name: `P${n}`, models: [model(n)], reply: () => text })),
      { id: "stale", name: "Stale", models: [model(1)], reply: () => text },
      { id: "public", name: "Public", models: [model(1), model(4)], reply: () => text },
    ] });
    for (const id of ["p1", "p2", "p3", "stale"]) {
      await h.ctx.db.insert(providerDisclosure).values({ providerId: id, retention: "attested", legalHold: false });
    }
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    h.ctx.cfg.agreements.apiKey = undefined;
    h.ctx.cfg.agreements.internal = true;
    h.ctx.cfg.agreements.models = [];
    h.ctx.cfg.agreements.rulings = false;
    h.ctx.cfg.agreements.signerKeys = undefined;
    for (const id of ["p1", "p2", "p3", "stale"]) await h.ctx.db.update(providers).set({ attested: true, teeKind: "tdx", attestationHash: `quote-${id}`, attestedAt: new Date(Date.now() - (id === "stale" ? h.ctx.cfg.attestation.intervalMs * 4 : 0)) }).where(eq(providers.id, id));
    await h.ctx.catalog.refresh();
    await h.ctx.db.delete(agreementJury);
    await h.ctx.db.delete(agreementProjection);
    await h.ctx.db.delete(agreementCursor);
    const scope = agreementScope(h.ctx.cfg);
    const a: Agreement = { id: "1.0", agreementId: "1", milestone: "0", creation: `${hash(1)}:0`, payer: addr(1), payee: addr(2), oracle: addr(5), amount: "5000000", termsHash: hash(2), deadline: "2000000000", deliverables: [hash(3)], state: "disputed", dispute: `${hash(4)}:0`, disputedAt: Math.floor(Date.now() / 1000) - 61 };
    await h.ctx.db.insert(agreementCursor).values({ scope, block: 4n, blockHash: hash(4), checkpoints: [], checkedAt: new Date() });
    await h.ctx.db.insert(agreementProjection).values({ scope, kind: "agreement", id: "1.0", data: a });
  });
  test("selects only fresh attested providers; keeps signed receipt refs and cost without customer billing", async () => {
    expect(juryCandidates(h.ctx, "jury/m1", {}).map(c => c.providerId)).toEqual(["p1"]);
    expect(selectableJuryModels(h.ctx, {})).toEqual(["jury/m1", "jury/m2", "jury/m3"]);
    expect(await runAgreementJury(h.ctx, router)).toMatchObject({ status: "dry_run" });
    const [record] = await h.ctx.db.select().from(agreementJury);
    const statement = record.statement as { votes: Vote[]; models: string[] };
    expect(statement.models).toEqual(["jury/m1", "jury/m2", "jury/m3"]);
    expect(await h.ctx.signer.verify(record.statement, record.signature, record.keyId)).toBe(true);
    for (const [i, vote] of statement.votes.entries()) {
      expect(vote.verdict?.verdict).toBe("pay");
      expect(vote.attestation_ref).toMatchObject({ provider: `p${i + 1}`, report_hash: `quote-p${i + 1}`, tee: "tdx" });
      expect(vote.receipt_url).toBeNull();
      expect(vote.operator_cost?.pico_usd).toMatch(/^\d+$/);
      expect(await h.ctx.signer.verify(vote.internal_receipt!.payload, vote.internal_receipt!.sig, vote.internal_receipt!.key_id)).toBe(true);
      const stats = await (await fetch(h.mocks[`p${i + 1}`].url + "/_stats")).json();
      expect(stats.lastAuth).toBe(`Bearer upstream-key-p${i + 1}`);
      expect(stats.lastBody.messages[0].content).toBe(JURY_RUBRIC);
    }
    for (const table of [generations, holds, ledger]) expect(await h.ctx.db.select().from(table)).toHaveLength(0);
    const transport: RulingTransport = { guard: async () => { throw Error("must not post"); }, prepare: async () => { throw Error("must not sign"); }, broadcast: async () => { throw Error("must not broadcast"); } };
    expect(await postAgreementRuling(h.ctx, transport)).toEqual({ skipped: "dry run" });
  });
  test("fewer than three selectable models remain awaiting jury, then retry when attestation returns", async () => {
    await h.ctx.db.update(providers).set({ attestedAt: new Date(0) }).where(eq(providers.id, "p3"));
    await h.ctx.catalog.refresh();
    expect(await runAgreementJury(h.ctx, router)).toMatchObject({ status: "awaiting_jury" });
    expect(await h.ctx.db.select().from(agreementJury)).toHaveLength(0);
    await h.ctx.db.update(providers).set({ attestedAt: new Date() }).where(eq(providers.id, "p3"));
    await h.ctx.catalog.refresh();
    expect(await runAgreementJury(h.ctx, router)).toMatchObject({ status: "dry_run" });
  });
  test("missing, development and stale attestations, undeclared retention and outage cannot serve", async () => {
    for (const patch of [{ attestationHash: null }, { teeKind: "dev" }, { attestedAt: new Date(0) }]) {
      await h.ctx.db.update(providers).set(patch).where(eq(providers.id, "p1"));
      await h.ctx.catalog.refresh();
      expect((await callInternalJuryModel(h.ctx, "jury/m1", {})).failure).toBe("no_fresh_attested_candidate");
      await h.ctx.db.update(providers).set({ teeKind: "tdx", attestationHash: "quote-p1", attestedAt: new Date() }).where(eq(providers.id, "p1"));
    }
    await h.ctx.catalog.refresh();
    h.ctx.catalog.disclosure.delete("p1");
    expect(juryCandidates(h.ctx, "jury/m1", {})).toHaveLength(0);
    await h.ctx.catalog.refresh();
    const original = h.ctx.health.outage;
    h.ctx.health.outage = () => true;
    try { expect(juryCandidates(h.ctx, "jury/m1", {})).toHaveLength(0); } finally { h.ctx.health.outage = original; }
  });
  test("internal flag defaults closed and API-key transport still uses the authenticated attested chat path", async () => {
    h.ctx.cfg.agreements.internal = false;
    expect(await runAgreementJury(h.ctx, router)).toEqual({ skipped: "internal jury disabled" });
    h.ctx.cfg.agreements.apiKey = "fixture-api-key";
    let calls = 0;
    const keyed = async (path: string, init?: RequestInit) => {
      calls++;
      expect(path).toBe("/api/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-api-key");
      const body = JSON.parse(init!.body as string);
      expect(body.provider).toEqual({ lane: "attested", disclosure: "none" });
      const payload = { id: `api-${body.model}`, lane: "attested", disclosure: "attested", model: body.model, response_sha256: sha256(text) };
      const signed = h.ctx.signer.sign(payload);
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }], receipt: { payload, key_id: signed.keyId, sig: signed.sig } }), { headers: { "x-anyroute-lane": "attested", "x-receipt-id": payload.id } });
    };
    expect(await runAgreementJury(h.ctx, keyed)).toMatchObject({ status: "dry_run" });
    expect(calls).toBe(3);
  });
  test("explicit incomplete panel stays awaiting jury", async () => {
    h.ctx.cfg.agreements.models = ["jury/m1", "jury/m2", "jury/m4"];
    expect(await runAgreementJury(h.ctx, router)).toMatchObject({ status: "awaiting_jury" });
    expect(await h.ctx.db.select().from(agreementJury)).toHaveLength(0);
  });
  test("gateway receipts must bind signed request/response bytes and verified attested upstream", async () => {
    const ks = keyset();
    const g: AciGateway = { v: 1, keysetDigest: keysetDigest(ks), workloadId: null, receiptKeys: ks.receipt_signing_keys as AciGateway["receiptKeys"], tlsSpki: [], notAfter: ks.not_after, staleAfter: null, serving: "aggregator", sourceProvenance: null, composeHash: null, osImageHash: null, appId: null, keysetEndorsement: "absent", attestedAt: new Date().toISOString() };
    let mode = "ok", receipt: unknown;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
      if (req.method === "GET") return Response.json(receipt);
      const requestBody = await req.text(), body = JSON.parse(requestBody);
      expect(body.provider).toEqual({ aci_verified: true, zdr: true });
      const bytes = JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 50, completion_tokens: 20 } });
      receipt = signedReceipt({ keysetDigest: g.keysetDigest, receiptId: "rcpt-jury", requestBody,
        responseBody: mode === "changed" ? "changed bytes" : bytes, key: mode === "signature" ? OTHER_KEY : RECEIPT_KEY,
        servedAt: Math.floor(Date.now()/1000), model: body.model,
        upstream: { result: mode === "unattested" ? "failed" : "verified", required: true, claims: CLAIMS_OK } });
      return new Response(bytes, { headers: { "content-type": "application/json", "x-receipt-id": "rcpt-jury" } });
    } });
    const p = h.ctx.catalog.providers.get("p1")!;
    p.baseUrl = server.url.toString(); p.aci = g;
    try {
      const vote = await callInternalJuryModel(h.ctx, "jury/m1", {});
      expect(vote.verdict?.verdict).toBe("pay");
      expect(vote.upstream_attestation).toMatchObject({ receipt_id: "rcpt-jury", receipt_verified: true, attested: true });
      for (mode of ["changed", "signature", "unattested"]) {
        const failed = await callInternalJuryModel(h.ctx, "jury/m1", {});
        expect(failed.verdict).toBeNull(); expect(failed.failure).toBe("invalid_upstream_attestation");
      }
    } finally { server.stop(true); }
  });
  test("internal calls enforce the provider's quote-bound TLS pin", async () => {
    const tls = generateTlsKey(), ref = "ab".repeat(32);
    const identity = createTlsIdentity(tls.privateKey, { attestationRef: ref, hostnames: ["localhost"] });
    let hits = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: identity.keyPem, cert: identity.certPem }, fetch: () => {
      hits++; return Response.json({ choices: [{ message: { content: text } }] });
    } });
    const p = h.ctx.catalog.providers.get("p1")!;
    p.baseUrl = `https://127.0.0.1:${server.port}`;
    p.tlsPin = { certPem: identity.certPem, spkiSha256: sha256(tls.spkiDer), attestationRef: ref, pinnedAt: new Date().toISOString() };
    try {
      expect((await callInternalJuryModel(h.ctx, "jury/m1", {})).verdict?.verdict).toBe("pay");
      expect(hits).toBe(1);
      const other = createTlsIdentity(generateTlsKey().privateKey, { attestationRef: ref, hostnames: ["localhost"] });
      let substituteHits = 0;
      const substitute = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: other.keyPem, cert: other.certPem }, fetch: () => {
        substituteHits++; return Response.json({ choices: [{ message: { content: text } }] });
      } });
      p.baseUrl = `https://127.0.0.1:${substitute.port}`;
      try {
        expect((await callInternalJuryModel(h.ctx, "jury/m1", {})).failure).toBe("call_failed");
        expect(substituteHits).toBe(0);
      } finally { substitute.stop(true); }
    } finally { server.stop(true); }
  });
  test("non-structured provider responses cannot count toward consensus", async () => {
    const original = h.ctx.catalog.providers.get("p1")!.baseUrl;
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: "not JSON" } }] }) });
    h.ctx.catalog.providers.get("p1")!.baseUrl = server.url.toString();
    try {
      const vote = await callInternalJuryModel(h.ctx, "jury/m1", {});
      expect(vote.verdict).toBeNull();
      expect(vote.failure).toBe("call_or_verdict_failed");
      expect(vote.attestation_ref).toBeDefined();
    } finally { h.ctx.catalog.providers.get("p1")!.baseUrl = original; server.stop(true); }
  });
});
