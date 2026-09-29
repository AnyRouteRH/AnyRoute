import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { attestations, providers } from "../src/db/schema.ts";
import { loadAciGateway, keysetDigest } from "../src/providers/aci.ts";
import { loadTlsPin } from "../src/providers/tls-pin.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runRegistry } from "../src/services/registry.ts";
import { encrypt } from "../src/lib/util.ts";
import { ADMIN, sse, startRouter, type Harness } from "./helpers.ts";
import { CLAIMS_OK, OTHER_KEY, RECEIPT_KEY, gatewayReport, keyset, phalaVerifierAnswer, session, signedReceipt, type Claims, type ReportOptions } from "./aci-fixtures.ts";

// An attested aci/1 gateway (providers/aci.ts) end to end against the router: a mock gateway that serves a report
// bound to the attestor's nonce, answers chat calls and signs a receipt for each, and a mock of the Phala quote
// verifier. Nothing here is real evidence.

const MODEL = "demo/aci-chat";
const RESTRICTED = "demo/aci-chat-uncensored";
const PLAIN = { id: "plain", slug: "lanetest/plain-chat", prompt: "0.0000001", completion: "0.0000002" };
const claim = { source: "https://gateway.example/terms", as_of: "2025-01-15" };
const admin = { "x-admin-token": ADMIN };

type State = {
  report: ReportOptions;
  verified: boolean;
  upstream: "verified" | "routed";
  claimsIn: "receipt" | "session";
  claims: Claims;
  receipt: "ok" | "missing" | "bad-signature" | "other-response";
  requests: { body: Record<string, any>; authorization: string | null }[];
};
const fresh = (): State => ({ report: {}, verified: true, upstream: "verified", claimsIn: "receipt", claims: CLAIMS_OK, receipt: "ok", requests: [] });
let state = fresh();
const receipts = new Map<string, unknown>();
const sessions = new Map<string, unknown>();
let seq = 0;

const enc = new TextEncoder();
function answer(model: string, stream: boolean) {
  if (!stream) return enc.encode(JSON.stringify({ id: "chatcmpl-gw", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "hello from the gateway" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const base = { id: "chatcmpl-gw", object: "chat.completion.chunk", created: 1, model };
  return enc.encode(
    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hello " } }] }) +
      chunk({ ...base, choices: [{ index: 0, delta: { content: "from the gateway" }, finish_reason: "stop" }] }) +
      chunk({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }) +
      "data: [DONE]\n\n",
  );
}

let gw: ReturnType<typeof Bun.serve>;
let verifier: ReturnType<typeof Bun.serve>;
let h: Harness;
let auth: Record<string, string>;

beforeAll(async () => {
  gw = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/v1/aci/attestation") return Response.json(gatewayReport(u.searchParams.get("nonce") ?? "", state.report));
      if (u.pathname === "/v1/models") return Response.json({ data: [] });
      if (u.pathname.startsWith("/v1/aci/receipts/")) {
        const doc = receipts.get(decodeURIComponent(u.pathname.slice("/v1/aci/receipts/".length)));
        return doc ? Response.json(doc) : new Response("not found", { status: 404 });
      }
      if (u.pathname.startsWith("/v1/aci/sessions/")) {
        const doc = sessions.get(decodeURIComponent(u.pathname.slice("/v1/aci/sessions/".length)));
        return doc ? Response.json(doc) : new Response("not found", { status: 404 });
      }
      if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
        const reqBytes = new Uint8Array(await req.arrayBuffer());
        const body = JSON.parse(new TextDecoder().decode(reqBytes));
        state.requests.push({ body, authorization: req.headers.get("authorization") });
        const stream = body.stream === true;
        const bytes = answer(body.model, stream);
        const id = `rcpt-${++seq}`;
        const servedAt = Math.floor(Date.now() / 1000);
        const s = session(state.claims, servedAt);
        sessions.set(s.id, s.doc);
        const upstream = state.upstream === "verified" ? { result: "verified", required: true, session_id: s.id, ...(state.claimsIn === "receipt" ? { claims: state.claims } : {}) } : { result: "failed", required: false };
        const doc = signedReceipt({
          keysetDigest: keysetDigest(state.report.keyset ?? keyset()),
          receiptId: id,
          requestBody: reqBytes,
          responseBody: state.receipt === "other-response" ? "something else" : bytes,
          upstream,
          servedAt,
          key: state.receipt === "bad-signature" ? OTHER_KEY : RECEIPT_KEY,
          model: body.model,
        });
        if (state.receipt !== "missing") receipts.set(id, doc);
        return new Response(bytes, { headers: { "content-type": stream ? "text/event-stream" : "application/json", "x-receipt-id": id } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => Response.json(phalaVerifierAnswer(((await req.json()) as { hex: string }).hex, state.verified)) });
  h = await startRouter({ providers: [{ id: "vendor", name: "Vendor", models: [PLAIN] }], env: { ATTESTATION_VERIFIERS: "phala", PHALA_VERIFIER_URL: `http://127.0.0.1:${verifier.port}/verify` } });
  const model = (id: string, name: string) => ({ id, name, anyroute: { slug: id }, context_length: 32768, max_completion_tokens: 4096, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["max_tokens", "temperature"] });
  await h.ctx.db.insert(providers).values({
    id: "gw",
    name: "Gateway",
    baseUrl: `http://127.0.0.1:${gw.port}/v1`,
    apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "gateway-key"),
    status: "live",
    dataPolicy: { training: false, retains_prompts: false, zdr: true },
    teeKind: "tdx",
    attestationUrl: `http://127.0.0.1:${gw.port}/v1/aci/attestation`,
    staticModels: [model(MODEL, "Demo ACI chat"), model(RESTRICTED, "Demo ACI chat uncensored")],
  });
  await runRegistry(h.ctx);
  const r = await h.request("/api/v1/disclosure/gw", { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  expect(r.status).toBe(200);
  auth = (await h.fundedKey(20n)).auth;
});
afterAll(async () => {
  gw.stop(true);
  verifier.stop(true);
  await h.close();
});
beforeEach(async () => {
  state = fresh();
  expect(await attest()).toMatchObject({ provider: "gw", ok: true });
});

async function attest() {
  const { results } = await runAttestor(h.ctx);
  await h.ctx.catalog.refresh();
  return (results as { provider: string; ok: boolean; reason?: string }[]).find((x) => x.provider === "gw");
}
const chat = (body: Record<string, unknown> = {}) => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 16, ...body } });
const attestedLane = { provider: { lane: "attested" } };

describe("attesting the gateway", () => {
  test("a report bound to the attestor's nonce and a verified quote: the keyset is stored and pinned to", async () => {
    const [row] = await h.ctx.db.select().from(providers).where(eq(providers.id, "gw"));
    expect(row).toMatchObject({ attested: true, classifierEnabled: false });
    const [att] = await h.ctx.db.select().from(attestations).where(and(eq(attestations.providerId, "gw"), eq(attestations.ok, true))).limit(1);
    expect(att.detail).toMatchObject({ verifiers: ["phala"], simulated: false, classifier_enabled: false, aci: { keyset_digest: keysetDigest(keyset()), receipt_keys: ["receipt-ed25519-v1"], tls_spki_sha256: null, keyset_endorsement: "absent", serving: "aggregator" } });
    expect((await loadAciGateway(h.ctx.db, "gw"))?.receiptKeys[0].public_key).toBe(RECEIPT_KEY.pub);
    // Over plain http (development only) there is no TLS key to pin.
    expect(await loadTlsPin(h.ctx.db, "gw")).toBeNull();
    const { data } = (await (await h.request("/api/v1/attestation/gw")).json()) as { data: any };
    expect(data).toMatchObject({ status: "attested", tee: "tdx", verifiers: ["phala"], gateway: { protocol: "aci/1", keyset_digest: keysetDigest(keyset()), source_provenance: { repo_commit: "ab".repeat(20) } } });
    expect(data.not_checked.at(-1)).toContain("attested gateway");
  });
  test("a replayed report, a rejected quote, another compose or a broken event log fail, and unattest the provider", async () => {
    const cases: [Partial<State>, string][] = [
      [{ report: { bindNonce: "11".repeat(32) } }, "report_data does not bind this nonce and keyset"],
      [{ verified: false }, "quote not verified (Phala verifier)"],
      [{ report: { mrConfigCompose: "77".repeat(32) } }, "the compose hash the verifiers report is not the one the event log measured"],
      [{ report: { tamperEvent: true } }, 'RTMR3 event "compose-hash" does not hash to its digest'],
      [{ report: { keyset: keyset({ notAfter: 1_000 }) } }, "keyset has expired (not_after)"],
    ];
    for (const [over, reason] of cases) {
      Object.assign(state, over);
      expect(await attest()).toMatchObject({ ok: false, reason });
      expect((await h.ctx.db.select().from(providers).where(eq(providers.id, "gw")))[0].attested).toBe(false);
      state = fresh();
      expect(await attest()).toMatchObject({ ok: true });
    }
  });
});

describe("each answer is checked against the gateway's receipt", () => {
  test("verified: the router's signed receipt carries the gateway's record, and the request asked for attested, zero-retention serving", async () => {
    const r = await chat({ provider: { sort: "price" } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.choices[0].message.content).toBe("hello from the gateway");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    expect(j.receipt.payload.disclosure).toBe("attested");
    expect(j.receipt.payload.upstream_attestation).toEqual({
      kind: "aci/1",
      receipt_id: `rcpt-${seq}`,
      workload_id: null,
      keyset_digest: keysetDigest(keyset()),
      receipt_verified: true,
      upstream: expect.objectContaining({ result: "verified", required: true, model_id: MODEL }),
      claims: { tee_attested: { status: "asserted", source: "hardware_proven" }, tcb_up_to_date: { status: "asserted", source: "hardware_proven" }, gpu_attested: { status: "asserted", source: "verifier_derived" }, model_weights_provenance: { status: "unknown" }, zdr: null },
      gpu_attested: true,
      attested: true,
      constraints: { aci_verified: true, zdr: true },
    });
    const sent = state.requests.at(-1)!;
    expect(sent.body.provider).toEqual({ aci_verified: true, zdr: true });
    expect(sent.authorization).toBe("Bearer gateway-key");
  });
  test("claims the receipt leaves to its session are read from the session, which must hash to the cited id", async () => {
    state.claimsIn = "session";
    const j = (await (await chat(attestedLane)).json()) as any;
    expect(j.receipt.payload.upstream_attestation).toMatchObject({ attested: true, gpu_attested: true, claims: { tee_attested: { status: "asserted" } } });
  });
  test("public lane: a routed answer is returned, recorded as not attested, and not served as attested", async () => {
    state.upstream = "routed";
    const r = await chat();
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.choices[0].message.content).toBe("hello from the gateway");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("policy");
    expect(j.receipt.payload).toMatchObject({ disclosure: "policy", upstream_attestation: { receipt_verified: true, attested: false, upstream: { result: "failed", required: false } } });
    expect(j.receipt.payload.upstream_attestation.reason).toContain("the upstream was not verified");
  });
  test("attested lane: an answer the receipt does not show as attested is withheld, billed and receipted", async () => {
    const cases: [Partial<State>, string][] = [
      [{ upstream: "routed" }, "the upstream was not verified"],
      [{ claims: { ...CLAIMS_OK, tee_attested: { status: "unknown" } } }, "tee_attested is not asserted"],
      [{ receipt: "bad-signature" }, "the receipt signature does not verify"],
      [{ receipt: "missing" }, "the receipt could not be fetched (HTTP 404)"],
      [{ receipt: "other-response" }, "the receipt does not commit to the response the router received"],
    ];
    for (const [over, reason] of cases) {
      state = { ...fresh(), ...over };
      const r = await chat(attestedLane);
      expect(r.status).toBe(502);
      const j = (await r.json()) as any;
      expect(j.error.type).toBe("upstream_not_attested");
      expect(j.error.message).toContain(reason);
      expect(j.choices).toBeUndefined();
      expect(j.usage.cost).toBeGreaterThan(0);
      expect(j.receipt.payload).toMatchObject({ lane: "attested", disclosure: "policy", upstream_attestation: { attested: false } });
      expect(j.receipt.payload.upstream_attestation.reason).toContain(reason);
    }
  });
  test("`:private` is held to the same rule", async () => {
    state.upstream = "routed";
    expect((await chat({ model: `${MODEL}:private` })).status).toBe(502);
  });
});

describe("streams", () => {
  const streamed = async (body: Record<string, unknown>) => sse(await chat({ stream: true, ...body }));
  const content = (events: any[]) => events.flatMap((e) => (e.choices ?? []).map((c: any) => c?.delta?.content ?? "")).join("");
  test("public lane: relayed as it arrives, and the receipt covers the exact stream bytes", async () => {
    const { events, done } = await streamed({});
    expect(done).toBe(true);
    expect(content(events)).toBe("hello from the gateway");
    const last = events.at(-1);
    expect(last.receipt.payload.upstream_attestation).toMatchObject({ receipt_verified: true, attested: true, gpu_attested: true });
  });
  test("attested lane: held until the receipt verifies, then delivered", async () => {
    const { events } = await streamed(attestedLane);
    expect(content(events)).toBe("hello from the gateway");
    expect(events.at(-1).receipt.payload.upstream_attestation.attested).toBe(true);
  });
  test("attested lane: a routed stream is never delivered; the error and the receipt are", async () => {
    state.upstream = "routed";
    const { events } = await streamed(attestedLane);
    expect(content(events)).toBe("");
    const err = events.find((e) => e.error);
    expect(err.error.type).toBe("upstream_not_attested");
    const last = events.at(-1);
    expect(last.receipt.payload).toMatchObject({ disclosure: "policy", upstream_attestation: { attested: false } });
    expect(last.usage.cost).toBeGreaterThan(0);
  });
});

describe("models and lanes", () => {
  test("the attested listing says whether the latest verified receipt asserted GPU attestation", async () => {
    await chat();
    await h.ctx.catalog.refresh();
    const listed = async (q: string) => ((await (await h.request(`/api/v1/models${q}`)).json()) as { data: any[] }).data.find((m) => m.id === MODEL);
    expect(await listed("?lane=attested")).toMatchObject({ gpu_attested: true });
    expect(await listed("")).not.toHaveProperty("gpu_attested");
    state.claims = { ...CLAIMS_OK, gpu_attested: { status: "unknown" } };
    await chat();
    await h.ctx.catalog.refresh();
    expect(await listed("?lane=attested")).toMatchObject({ gpu_attested: false });
  });
  test("a restricted variant is never sent to the gateway: it binds no in-enclave classifier", async () => {
    const before = state.requests.length;
    const r = await chat({ model: RESTRICTED, ...attestedLane });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await chat({ model: RESTRICTED })).status).toBeGreaterThanOrEqual(400);
    expect(state.requests.length).toBe(before);
  });
});
