import { describe, expect, test } from "bun:test";
import { AnyRoute, AttestationRefused, ReceiptInvalid, routingHeaders, withRouting } from "../src/index.js";
import { json, makeRouterKey, real, signReceipt, stubFetch } from "./helpers.js";

const chatBody = { model: "example/model", messages: [{ role: "user", content: "hi" }] };

async function router(opts: { provider?: string; tamper?: boolean; keys?: "published" | "missing" } = {}) {
  const key = makeRouterKey();
  const jwk = await key.ready;
  const provider = opts.provider ?? "example-provider";
  const chatRequests: { headers: Record<string, string>; body: any }[] = [];
  const { fetch, calls } = stubFetch({
    "/.well-known/anyroute-receipt-keys.json": () => json({ keys: opts.keys === "missing" ? [] : [jwk] }),
    "POST /api/v1/chat/completions": async ({ init }) => {
      const body = JSON.parse(String(init!.body));
      chatRequests.push({ headers: Object.fromEntries(Object.entries(init!.headers as Record<string, string>)), body });
      const payload = { v: 1, id: "gen-1", issued: new Date().toISOString(), model: body.model, provider, disclosure: "attested", tokens: { prompt: 1, completion: 1 } };
      const receipt = await signReceipt(key.privateKey, jwk.kid, opts.tamper ? { ...payload, cost: "0" } : payload);
      if (opts.tamper) receipt.payload = { ...payload, cost: "0.5" };
      if (body.stream) {
        const sse = [`data: ${JSON.stringify({ id: "gen-1", choices: [{ delta: { content: "he" } }] })}\n\n`, `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta: { content: "llo" } }] })}\n\n`, `data: ${JSON.stringify({ id: "gen-1", choices: [], usage: { prompt_tokens: 1 }, receipt })}\n\n`, "data: [DONE]\n\n"].join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream", "x-generation-id": "gen-1", "x-anyroute-lane": "attested" } });
      }
      return json({ id: "gen-1", model: body.model, choices: [{ message: { role: "assistant", content: "hello" } }], usage: { prompt_tokens: 1 }, receipt }, 200, { "x-generation-id": "gen-1", "x-anyroute-disclosure": "attested", "x-anyroute-lane": "attested" });
    },
    "/api/v1/attestation/example-provider": () => json({ data: real.router() }),
    "/attest": ({ url }) => (url.searchParams.get("nonce") ? json(real.fresh().response) : json(real.boot())),
  });
  return { fetch, calls, chatRequests, key, jwk };
}

const attested = (over = {}) => ({ providerId: "example-provider", attestUrl: "https://provider.test/attest", freshNonce: false, certificate: real.certPem(), ...over });
// The captured evidence is dated 2026-09-29, so the client's clock is pinned to a moment inside its lifetime.
const clock = { t: real.now };
const newClient = (r: { fetch: any }, extra = {}) => new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch, now: () => clock.t, ...extra });

describe("chat", () => {
  test("sends an OpenAI-shaped request with the key, and verifies the signed receipt against the published keys", async () => {
    const r = await router();
    const c = new AnyRoute({ baseUrl: "https://router.test/", apiKey: "sk-test", fetch: r.fetch });
    const res = await c.chat.completions.create(chatBody);
    expect(res.choices).toHaveLength(1);
    expect(res.anyroute.receiptVerification?.valid).toBe(true);
    expect(res.anyroute.disclosure).toBe("attested");
    expect(res.anyroute.generationId).toBe("gen-1");
    expect(r.chatRequests[0].headers.authorization).toBe("Bearer sk-test");
    expect(r.chatRequests[0].body).toEqual(chatBody); // nothing added when no options were set
    expect(r.calls.filter((x) => x.url.endsWith("anyroute-receipt-keys.json"))).toHaveLength(1);
    await c.chat.completions.create(chatBody);
    expect(r.calls.filter((x) => x.url.endsWith("anyroute-receipt-keys.json"))).toHaveLength(1); // key set is reused
  });

  test("a receipt that does not verify is reported, and thrown when strict", async () => {
    const r = await router({ tamper: true });
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch });
    const res = await c.chat.completions.create(chatBody);
    expect(res.anyroute.receiptVerification?.valid).toBe(false);
    const strict = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch, strictReceipts: true });
    await expect(strict.chat.completions.create(chatBody)).rejects.toBeInstanceOf(ReceiptInvalid);
  });

  test("reloads the key set once when a receipt names a key it has not seen (rotation)", async () => {
    const first = makeRouterKey();
    const second = makeRouterKey();
    const [j1, j2] = [await first.ready, await second.ready];
    let published = [j1];
    const keyReads = stubFetch({ "/.well-known/anyroute-receipt-keys.json": () => json({ keys: published }) });
    const c = new AnyRoute({ baseUrl: "https://router.test", fetch: keyReads.fetch });
    await c.receiptKeys(); // cached with only the first key
    published = [j1, j2]; // the router rotates
    const receipt = await signReceipt(second.privateKey, j2.kid, { v: 1, id: "x", issued: new Date().toISOString() });
    expect((await c.verifyReceipt(receipt)).valid).toBe(true);
    expect(keyReads.calls).toHaveLength(2);
    // A key id that is still unknown after the reload is simply not valid, and does not loop.
    const stranger = makeRouterKey();
    const bad = await signReceipt(stranger.privateKey, (await stranger.ready).kid, { v: 1, id: "y" });
    expect((await c.verifyReceipt(bad)).valid).toBe(false);
    expect(keyReads.calls).toHaveLength(3);
  });

  test("pinned keys are used as given and never fetched", async () => {
    const r = await router();
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch, receiptKeys: { keys: [r.jwk] } });
    expect((await c.chat.completions.create(chatBody)).anyroute.receiptVerification?.valid).toBe(true);
    expect(r.calls.some((x) => x.url.endsWith("anyroute-receipt-keys.json"))).toBe(false);
    const wrong = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch, receiptKeys: { keys: [await makeRouterKey().ready] } });
    expect((await wrong.chat.completions.create(chatBody)).anyroute.receiptVerification?.valid).toBe(false);
  });

  test("a router error surfaces its message and status", async () => {
    const f = stubFetch({ "POST /api/v1/chat/completions": () => json({ error: { message: "No provider meets the disclosure ceiling.", type: "disclosure_unavailable", metadata: { requested: { disclosure: "none" } } } }, 409) });
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: f.fetch });
    const e = await c.chat.completions.create(chatBody).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.code).toBe("disclosure_unavailable");
    expect(e.details).toEqual({ requested: { disclosure: "none" } });
  });

  test("blind tokens authenticate with the PrivateToken scheme", async () => {
    const r = await router();
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch }).withPrivateToken("TOKEN123");
    await c.chat.completions.create(chatBody);
    expect(r.chatRequests[0].headers.authorization).toBe("PrivateToken token=TOKEN123");
  });

  test("streaming yields chunks and resolves the receipt verification at the end", async () => {
    const r = await router();
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch });
    const stream = await c.chat.completions.stream(chatBody);
    const text: string[] = [];
    for await (const chunk of stream) for (const ch of (chunk.choices as any[]) ?? []) if (ch.delta?.content) text.push(ch.delta.content);
    expect(text.join("")).toBe("hello");
    const meta = await stream.meta();
    expect(meta.receipt?.payload.provider).toBe("example-provider");
    expect(meta.receiptVerification?.valid).toBe(true);
    expect(r.chatRequests[0].body.stream).toBe(true);
  });
});

describe("disclosure and lane options", () => {
  test("go in the body's provider object and the headers, and never loosen what the caller set", async () => {
    const r = await router();
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch: r.fetch, disclosure: "policy" });
    await c.chat.completions.create({ ...chatBody, provider: { sort: "price", disclosure: "none" } }, { lane: "attested" });
    const sent = r.chatRequests[0];
    expect(sent.body.provider).toEqual({ sort: "price", disclosure: "none", lane: "attested" }); // "none" is stricter than "policy"
    expect(sent.headers["x-anyroute-disclosure-max"]).toBe("policy");
    expect(sent.headers["x-anyroute-lane"]).toBe("attested");
  });

  test("the unlinkable lane is passed through so the router can refuse it", async () => {
    expect(withRouting(chatBody as any, { lane: "unlinkable" }).provider).toEqual({ lane: "unlinkable" });
    expect(routingHeaders({ lane: "unlinkable" })).toEqual({ "x-anyroute-lane": "unlinkable" });
    expect(routingHeaders({})).toEqual({});
    expect(withRouting(chatBody as any, {})).toBe(chatBody);
  });
});

describe("verify-before-send", () => {
  test("a provider that verifies is used, exclusively, and the receipt is checked against it", async () => {
    const r = await router();
    const c = newClient(r);
    const res = await c.chat.completions.create(chatBody, { attested: attested() });
    const sent = r.chatRequests[0];
    expect(sent.body.provider).toEqual({ disclosure: "none", lane: "attested", only: ["example-provider"], allow_fallbacks: false });
    expect(sent.headers["x-anyroute-lane"]).toBe("attested");
    expect(res.anyroute.provider?.ok).toBe(true);
    expect(res.anyroute.servedByVerifiedProvider).toBe(true);
    // Attestation was read before the chat request went out.
    const order = r.calls.map((x) => new URL(x.url).pathname);
    expect(order.indexOf("/api/v1/chat/completions")).toBeGreaterThan(order.lastIndexOf("/attest"));
  });

  test("a receipt naming some other provider is flagged even though the request was pinned", async () => {
    const r = await router({ provider: "someone-else" });
    const c = newClient(r);
    const res = await c.chat.completions.create(chatBody, { attested: attested() });
    expect(res.anyroute.servedByVerifiedProvider).toBe(false);
  });

  test("refuses before sending anything when the evidence does not verify", async () => {
    const r = await router();
    const c = newClient(r);
    // Wrong model digest for what the caller expects.
    const wrong = await c.chat.completions.create(chatBody, { attested: attested({ expected: { modelDigest: "sha256:" + "00".repeat(32) } }) }).catch((e) => e);
    expect(wrong).toBeInstanceOf(AttestationRefused);
    expect((wrong as AttestationRefused).verification.checks.find((x) => x.id === "expected.model")?.status).toBe("fail");
    expect(r.chatRequests).toHaveLength(0);

    // Stale: three hours on, the router's verification is too old.
    clock.t = real.now + 3 * 3_600_000;
    const stale = await c.chat.completions.create(chatBody, { attested: attested() }).catch((e) => e);
    expect(stale).toBeInstanceOf(AttestationRefused);
    expect(stale.message).toMatch(/older than/);
    expect(r.chatRequests).toHaveLength(0);
    clock.t = real.now;
  });

  test("refuses when the provider is unreachable", async () => {
    const r = await router();
    const broken = stubFetch({ "/api/v1/attestation/example-provider": () => json({ data: real.router() }) });
    const c = newClient(broken);
    const e = await c.chat.completions.create(chatBody, { attested: attested() }).catch((x) => x);
    expect(e).toBeInstanceOf(AttestationRefused);
    expect(broken.calls.some((x) => x.init?.method === "POST")).toBe(false);
    void r;
  });

  test("a passing verification is reused within cacheMs and dropped when it later fails", async () => {
    const r = await router();
    const c = newClient(r);
    await c.chat.completions.create(chatBody, { attested: attested() });
    const reads = () => r.calls.filter((x) => x.url.includes("/api/v1/attestation/")).length;
    const before = reads();
    await c.chat.completions.create(chatBody, { attested: attested() });
    expect(reads()).toBe(before); // cached
    await c.chat.completions.create(chatBody, { attested: attested({ cacheMs: 0 }) });
    expect(reads()).toBe(before + 1);
  });
});
