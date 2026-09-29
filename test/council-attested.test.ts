import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { saveTlsPin } from "../src/providers/tls-pin.ts";
import { generations, holds, providers as providersTable } from "../src/db/schema.ts";
import { attestationRefOf, parseCouncilSpec } from "../src/router/council.ts";

// Attested council and attested dual verification. The providers here are development-attested mocks (tee "dev"), which
// the harness accepts because it runs outside production; a production router refuses dev evidence, so none of these
// would be attested there. Providers that are not declared attested play the vendor.

const LLAMA = MODELS.llama.slug;
const QWEN = MODELS.qwen.slug;
const model = (n: string) => ({ id: `${n}-upstream`, slug: `acme/${n}`, prompt: "0.0000001", completion: "0.0000004" });
const TEXT: Record<string, string> = { "m1-upstream": "answer one", "m2-upstream": "answer two", "m3-upstream": "answer three" };
const reply = (prompt: string, body: any) => (prompt.includes("Valid winners") ? '{"winner":"A","reason":"clearest"}' : TEXT[body.model]);
const PIN = { certPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----", spkiSha256: "ab".repeat(32), attestationRef: "cd".repeat(32), pinnedAt: "2026-01-01T00:00:00.000Z" };

describe("attested council helpers", () => {
  const defaults = { models: [], judge: null, mode: "judge" as const };
  const base = { models: ["a/x", "b/y"], judge: "c/z" };

  test("council.attested is a boolean; it is reported on the spec only when true", () => {
    expect(parseCouncilSpec({ ...base, attested: true }, defaults)).toMatchObject({ attested: true });
    expect("attested" in parseCouncilSpec({ ...base, attested: false }, defaults)).toBe(false);
    expect("attested" in parseCouncilSpec(base, defaults)).toBe(false);
    for (const attested of ["yes", 1, "true", []]) {
      try {
        parseCouncilSpec({ ...base, attested }, defaults);
        throw new Error("expected a 400");
      } catch (e: any) {
        expect(e.status).toBe(400);
        expect(e.type).toBe("invalid_council");
      }
    }
  });

  test("attestationRefOf names only what the router holds: nothing without a report hash, a pin only when there is one, dev marked simulated", () => {
    const at = new Date("2026-05-01T00:00:00Z");
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: null, attestedAt: at })).toBeNull();
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: "h1", attestedAt: at })).toEqual({ provider: "p", tee: "tdx", report_hash: "h1", attested_at: at.toISOString(), tls_pin: null });
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: "h1", attestedAt: at, tlsPin: { spkiSha256: "s", attestationRef: "r" } })?.tls_pin).toEqual({ spki_sha256: "s", attestation_ref: "r" });
    expect(attestationRefOf({ id: "p", teeKind: "dev", attestationHash: "h1", attestedAt: null })).toMatchObject({ simulated: true, attested_at: null });
    expect(attestationRefOf({ id: "p", teeKind: "tdx", attestationHash: "h1", attestedAt: at })).not.toHaveProperty("simulated");
  });
});

describe("attested council over HTTP", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const admin = { "x-admin-token": ADMIN };
  const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
  const declareAttested = (id: string) => h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  beforeAll(async () => {
    h = await startRouter({
      env: { ANYROUTE_FEATURE_COUNCIL: "true" },
      providers: [
        { id: "enc1", name: "Enc1", models: [model("m1"), model("judge"), MODELS.llama], tee: "dev", reply },
        { id: "enc2", name: "Enc2", models: [model("m2"), MODELS.llamaPricey], tee: "dev", reply },
        { id: "solo", name: "Solo", models: [MODELS.qwen], tee: "dev", reply },
        { id: "ven", name: "Ven", models: [model("m3"), model("vjudge"), MODELS.llama, MODELS.qwen], reply },
      ],
    });
    auth = (await h.fundedKey(20n)).auth;
    for (const id of ["enc1", "enc2", "solo"]) expect((await declareAttested(id)).status).toBe(200);
    expect(((await runAttestor(h.ctx)).results as any[]).every((x) => x.ok)).toBe(true);
    // enc1 attested through a self-signed certificate, so the router pinned it (enc2 did not). The mock listens on plain
    // http, so the pin is only recorded in receipts here, not used for a handshake.
    await saveTlsPin(h.ctx.db, "enc1", PIN);
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => h.close());

  const ask = (body: Record<string, unknown>) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: "anyroute/council", messages: [{ role: "user", content: "which one?" }], max_tokens: 60, ...body } });
  const council = (models: string[], extra: Record<string, unknown> = {}, judge = "acme/judge") => ({ council: { models, judge, ...extra } });
  const dual = (provider: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: LLAMA, messages: [{ role: "user", content: "What is 17 * 23?" }], max_tokens: 30, verify: "dual", provider, ...extra } });
  const requests = async () => Object.fromEntries(await Promise.all(Object.entries(h.mocks).map(async ([id, m]) => [id, (await (await fetch(m.url + "/_stats")).json()).requests as number])));
  const generationCount = async () => (await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(generations))[0].n;
  const openHolds = async () => (await h.ctx.db.select().from(holds).where(eq(holds.status, "held"))).length;
  const hashOf = async (id: string) => (await h.ctx.db.select().from(providersTable).where(eq(providersTable.id, id)))[0].attestationHash;
  const verifySig = async (receipt: any, payload = receipt.payload) =>
    (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload, sig: receipt.sig, key_id: receipt.key_id } })).json()).data.signature_valid;
  /** The refs in a response's list, without the fields that say which call they belong to. */
  const bare = ({ role: _r, label: _l, receipt_id: _i, ...ref }: any) => ref;

  test("council.attested: every member and the judge are attested; each receipt records its provider's attestation, and the list is signed", async () => {
    const r = await ask(council(["acme/m1", "acme/m2"], { attested: true }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(r.headers.get("x-anyroute-lane")).toBe("attested");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    expect(j.council.attested).toBe(true);
    expect(j.council.attestation_simulated).toBe(true); // development evidence, and it says so
    expect(j.council.members.map((m: any) => [m.label, m.provider, m.disclosure, m.status])).toEqual([
      ["A", "enc1", "attested", "ok"],
      ["B", "enc2", "attested", "ok"],
    ]);
    expect(j.council.judge).toMatchObject({ provider: "enc1", disclosure: "attested" });

    const refs = j.council.attestation_refs;
    expect(refs.map((x: any) => [x.role, x.label ?? null, x.provider])).toEqual([["member", "A", "enc1"], ["member", "B", "enc2"], ["judge", null, "enc1"]]);
    expect(refs.map((x: any) => x.receipt_id)).toEqual([j.council.members[0].receipt_id, j.council.members[1].receipt_id, j.id]);
    const enc1 = { provider: "enc1", tee: "dev", report_hash: await hashOf("enc1"), tls_pin: { spki_sha256: PIN.spkiSha256, attestation_ref: PIN.attestationRef }, simulated: true };
    const enc2 = { provider: "enc2", tee: "dev", report_hash: await hashOf("enc2"), tls_pin: null, simulated: true };
    expect(bare(refs[0])).toMatchObject(enc1);
    expect(bare(refs[1])).toMatchObject(enc2);
    expect(bare(refs[2])).toMatchObject(enc1);
    expect(refs[0].report_hash).toMatch(/\S/);

    // Each call's own stored receipt names its provider's attestation, and says it was served on the attested lane.
    const rows = await h.ctx.db.select().from(generations).where(inArray(generations.id, refs.map((x: any) => x.receipt_id)));
    expect(rows.length).toBe(3);
    for (const x of refs) {
      const row = rows.find((y) => y.id === x.receipt_id)!;
      expect(row.receipt).toMatchObject({ lane: "attested", disclosure: "attested", attestation: x.report_hash, attestation_ref: bare(x) });
    }
    // The top-level receipt is the judge's: its own reference, plus the signed list. Changing either breaks the signature.
    expect(j.receipt.payload.attestation_ref).toEqual(bare(refs[2]));
    expect(j.receipt.payload.council.attested).toBe(true);
    expect(j.receipt.payload.council.attestation_refs).toEqual(refs);
    expect(await verifySig(j.receipt)).toBe(true);
    const forgedList = structuredClone(j.receipt.payload);
    forgedList.council.attestation_refs[0].report_hash = "0".repeat(64);
    expect(await verifySig(j.receipt, forgedList)).toBe(false);
    const forgedOwn = structuredClone(j.receipt.payload);
    forgedOwn.attestation_ref.report_hash = "0".repeat(64);
    expect(await verifySig(j.receipt, forgedOwn)).toBe(false);
  });

  test("lane attested on a council request is the same as council.attested", async () => {
    for (const patch of [{ provider: { lane: "attested" } }, { provider: { lane: "attested" }, ...council(["acme/m1", "acme/m2"], { attested: true }) }]) {
      const r = await ask({ ...council(["acme/m1", "acme/m2"]), ...patch });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(r.headers.get("x-anyroute-lane")).toBe("attested");
      expect(j.council.attested).toBe(true);
      expect(j.council.attestation_refs.length).toBe(3);
      expect(j.receipt.payload).toMatchObject({ lane: "attested", disclosure: "attested" });
    }
    const viaHeader = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth, "x-anyroute-lane": "attested" }, json: { model: "anyroute/council", messages: [{ role: "user", content: "x" }], max_tokens: 30, ...council(["acme/m1", "acme/m2"]) } });
    expect(viaHeader.status).toBe(200);
    expect((await viaHeader.json()).council.attested).toBe(true);
  });

  test("a council that did not ask for it is unchanged: no attested flag, no references in any receipt", async () => {
    const r = await ask(council(["acme/m1", "acme/m2"]));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(r.headers.get("x-anyroute-lane")).toBe("public");
    expect(j.council).not.toHaveProperty("attested");
    expect(j.council).not.toHaveProperty("attestation_refs");
    expect(j.receipt.payload).not.toHaveProperty("attestation_ref");
    const rows = await h.ctx.db.select().from(generations).where(inArray(generations.id, j.council.members.map((m: any) => m.receipt_id)));
    for (const row of rows) expect(row.receipt).not.toHaveProperty("attestation_ref");
    // `council.attested: false` is the same as leaving it out.
    const off = await (await ask(council(["acme/m1", "acme/m2"], { attested: false }))).json();
    expect(off.council).not.toHaveProperty("attested");
  });

  test("a member with no attested provider refuses the whole council: no member is dropped, none is served by the vendor", async () => {
    const before = await requests();
    const count = await generationCount();
    for (const [models, extra, seat, model] of [
      [["acme/m1", "acme/m3"], { attested: true }, "member B", "acme/m3"], // one attested member is not a council
      [["acme/m1", "acme/m2", "acme/m3"], { attested: true }, "member C", "acme/m3"], // two of three is not enough either
      [["acme/m1", "acme/m2", "acme/m3"], { attested: true, min_members: 2 }, "member C", "acme/m3"],
    ] as const) {
      const r = await ask(council([...models], { ...extra }));
      expect(r.status).toBe(409);
      const e = (await r.json()).error;
      expect(e.type).toBe("lane_unavailable");
      expect(e.message).toContain(model);
      expect(e.message).toMatch(/Nothing was sent to any provider and nothing was charged/);
      expect(e.metadata).toMatchObject({ council_seat: seat, requested: { disclosure: "none", lane: "attested" } });
      expect(e.metadata.excluded.length).toBeGreaterThan(0);
    }
    // Lane "attested" on the request alone is held to the same rule.
    const viaLane = await ask({ ...council(["acme/m1", "acme/m3"]), provider: { lane: "attested" } });
    expect(viaLane.status).toBe(409);
    expect((await viaLane.json()).error.type).toBe("lane_unavailable");
    expect(await requests()).toEqual(before);
    expect(await generationCount()).toBe(count);
    expect(await openHolds()).toBe(0);
    // Without the flag the same members are served, vendor included: the refusal above is the flag's doing.
    const plain = await ask(council(["acme/m1", "acme/m3"]));
    expect(plain.status).toBe(200);
    expect((await plain.json()).council.members.map((m: any) => m.provider)).toEqual(["enc1", "ven"]);
  });

  test("no attested judge is a 409, even when the members are attested", async () => {
    const before = await requests();
    const count = await generationCount();
    const r = await ask(council(["acme/m1", "acme/m2"], { attested: true }, "acme/vjudge"));
    expect(r.status).toBe(409);
    const e = (await r.json()).error;
    expect(e.type).toBe("lane_unavailable");
    expect(e.message).toContain("acme/vjudge");
    expect(e.metadata.council_seat).toBe("judge");
    expect(await requests()).toEqual(before);
    expect(await generationCount()).toBe(count);
    expect(await openHolds()).toBe(0);
  });

  test("a lapsed attestation counts as not attested", async () => {
    const [{ attestedAt }] = await h.ctx.db.select().from(providersTable).where(eq(providersTable.id, "enc2"));
    await h.ctx.db.update(providersTable).set({ attestedAt: new Date(Date.now() - 10 * h.ctx.cfg.attestation.intervalMs) }).where(eq(providersTable.id, "enc2"));
    await h.ctx.catalog.refresh();
    try {
      const before = await requests();
      const r = await ask(council(["acme/m1", "acme/m2"], { attested: true }));
      expect(r.status).toBe(409);
      const e = (await r.json()).error;
      expect(e.type).toBe("lane_unavailable");
      expect(e.metadata.council_seat).toBe("member B");
      expect(await requests()).toEqual(before);
    } finally {
      await h.ctx.db.update(providersTable).set({ attestedAt }).where(eq(providersTable.id, "enc2"));
      await h.ctx.catalog.refresh();
    }
    expect((await ask(council(["acme/m1", "acme/m2"], { attested: true }))).status).toBe(200);
  });

  test("attested providers that are down give a 503, not a fallback", async () => {
    const health = h.ctx.health as unknown as { outage: (m: string, p: string) => boolean };
    const original = health.outage.bind(h.ctx.health);
    health.outage = (m, p) => p === "enc2" || original(m, p);
    try {
      const before = await requests();
      const r = await ask(council(["acme/m1", "acme/m2"], { attested: true }));
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("30");
      const e = (await r.json()).error;
      expect(e.type).toBe("disclosure_provider_unavailable");
      expect(e.metadata.council_seat).toBe("member B");
      expect(await requests()).toEqual(before);
    } finally {
      health.outage = original;
    }
    expect((await ask(council(["acme/m1", "acme/m2"], { attested: true }))).status).toBe(200);
  });

  test("a non-boolean council.attested is a 400 before anything is sent", async () => {
    const before = await requests();
    const r = await ask(council(["acme/m1", "acme/m2"], { attested: "yes" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("invalid_council");
    expect(await requests()).toEqual(before);
  });

  test("fuse mode: the judge's own text, attested judge, references in the signed block", async () => {
    const r = await ask({ ...council(["acme/m1", "acme/m2"], { attested: true, mode: "fuse" }), messages: [{ role: "user", content: "combine" }] });
    // The mock has no fused reply for this judge prompt, so it answers with its default text; what matters is who was asked.
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.council).toMatchObject({ mode: "fuse", outcome: "fused", attested: true });
    expect(j.council.attestation_refs.map((x: any) => x.role)).toEqual(["member", "member", "judge"]);
    expect(await verifySig(j.receipt)).toBe(true);
  });

  // ---- Dual verification on the attested lane -----------------------------------------------------------------------

  test("verify dual on lane attested: two different attested providers, the agreement bit and both references in both receipts", async () => {
    const r = await dual({ lane: "attested" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(r.headers.get("x-anyroute-lane")).toBe("attested");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    expect([...j.verification.providers].sort()).toEqual(["enc1", "enc2"]);
    expect(j.verification).toMatchObject({ agree: true, attested: true });
    const refs = j.verification.attestation_refs;
    expect(refs.map((x: any) => x.provider).sort()).toEqual(["enc1", "enc2"]);
    expect(refs.map((x: any) => x.receipt_id)).toEqual(j.verification.receipts);
    for (const x of refs) expect(x.report_hash).toBe(await hashOf(x.provider));
    expect(refs.find((x: any) => x.provider === "enc1").tls_pin).toEqual({ spki_sha256: PIN.spkiSha256, attestation_ref: PIN.attestationRef });
    expect(refs.find((x: any) => x.provider === "enc2").tls_pin).toBeNull();

    const rows = await h.ctx.db.select().from(generations).where(inArray(generations.id, j.verification.receipts));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const own = refs.find((x: any) => x.receipt_id === row.id);
      expect(row.providerId).toBe(own.provider);
      expect(row.receipt).toMatchObject({ lane: "attested", disclosure: "attested", attestation_ref: bare(own), verification: { mode: "dual", agree: true, attested: true, attestation_refs: refs } });
    }
    expect(j.receipt.payload.attestation_ref).toEqual(bare(refs[0]));
    expect(await verifySig(j.receipt)).toBe(true);
    const forged = structuredClone(j.receipt.payload);
    forged.verification.attestation_refs[1].report_hash = "0".repeat(64);
    expect(await verifySig(j.receipt, forged)).toBe(false);
  });

  test("a disagreement is still reported as one on the attested lane", async () => {
    const j = await (await dual({ lane: "attested" }, { messages: [{ role: "user", content: "say something" }] })).json();
    expect(j.verification).toMatchObject({ agree: false, match: "none", attested: true });
    expect(j.receipt.payload.verification.agree).toBe(false);
  });

  test("dual on lane attested with one attested provider of the model is a 409: nothing sent or charged", async () => {
    const before = await requests();
    const count = await generationCount();
    for (const [model, provider] of [
      [QWEN, { lane: "attested" }], // solo is attested, the vendor is not
      [LLAMA, { lane: "attested", only: ["enc1", "ven"] }],
    ] as const) {
      const r = await dual(provider, { model });
      expect(r.status).toBe(409);
      const e = (await r.json()).error;
      expect(e.type).toBe("verification_unavailable");
      expect(e.message).toMatch(/two different attested providers/);
      expect(e.metadata.eligible.length).toBe(1);
      expect(e.metadata.requested).toEqual({ lane: "attested", disclosure: "none" });
    }
    // None at all: refused by the lane itself.
    const none = await dual({ lane: "attested", only: ["ven"] });
    expect(none.status).toBe(409);
    expect((await none.json()).error.type).toBe("lane_unavailable");
    expect(await requests()).toEqual(before);
    expect(await generationCount()).toBe(count);
    expect(await openHolds()).toBe(0);
  });

  test("dual without the lane carries no attested block, even when both providers happen to be attested", async () => {
    const j = await (await dual({ only: ["enc1", "enc2"] })).json();
    expect(j.verification).not.toHaveProperty("attested");
    expect(j.verification).not.toHaveProperty("attestation_refs");
    expect(j.receipt.payload).not.toHaveProperty("attestation_ref");
  });
});
