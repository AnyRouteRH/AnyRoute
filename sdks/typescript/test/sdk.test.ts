import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Anyroute, AnyrouteAPIError, NotFoundError, RateLimitError, parseRetryAfter, supportsLane, verifyReceiptV2, type Receipt } from "../src/index.js";
import { JWKS, V2, startFakeRouter } from "./fake-router.js";

let router: ReturnType<typeof startFakeRouter>;
let client: Anyroute;
const noSleep = async () => {};

beforeAll(() => {
  router = startFakeRouter();
  client = new Anyroute({ apiKey: "test-key", baseUrl: `${router.url}/api/v1`, sleep: noSleep });
});
afterAll(() => router.stop());
const last = (path: string) => [...router.seen].reverse().find((s) => s.path.startsWith(path))!;

describe("chat", () => {
  test("non-stream: verifies receipt v1 and v2, surfaces lane and receipt id", async () => {
    const r = await client.chat.completions.create({ model: "example/model", messages: [{ role: "user", content: "hi" }] }, { lane: "attested" });
    expect((r.choices?.[0] as any).message.content).toBe("Hello");
    expect(r.anyroute.lane).toBe("attested");
    expect(r.anyroute.generationId).toBe(V2.claims.rid);
    expect(r.anyroute.receiptVerification?.valid).toBe(true);
    expect(r.anyroute.receiptV2Verification?.valid).toBe(true);
    const sent = last("/api/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer test-key");
    expect(sent.headers.get("x-anyroute-lane")).toBe("attested");
    expect(sent.body.provider.lane).toBe("attested");
  });

  test("a lane option never loosens a stricter lane already in the body", async () => {
    const pub = client.withLane("public");
    await pub.chat.completions.create({ model: "example/model", messages: [], provider: { lane: "attested" } });
    expect(last("/api/v1/chat/completions").body.provider.lane).toBe("attested");
  });

  test("stream: chunks, receipt, and the chunk chain verify", async () => {
    const s = await client.chat.completions.stream({ model: "example/model", messages: [{ role: "user", content: "hi" }] });
    let text = "";
    for await (const c of s) text += ((c as any).choices?.[0]?.delta?.content as string) ?? "";
    expect(text).toBe("Hello");
    const meta = await s.meta();
    expect(meta.receipt?.id).toBe(V2.claims.rid);
    expect(meta.receiptVerification?.valid).toBe(true);
    const chain = await s.verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.head).toBe(V2.claims.resp.chain);
  });

  test("stream: an altered chunk breaks the chain at that event", async () => {
    router.state.tamperStream = true;
    try {
      const s = await client.chat.completions.stream({ model: "example/model", messages: [] });
      for await (const _ of s);
      const chain = await s.verifyChain();
      expect(chain.ok).toBe(false);
      expect(chain.firstMismatch).toBe(2);
    } finally {
      router.state.tamperStream = false;
    }
  });
});

describe("errors and retries", () => {
  test("429 is retried after Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const c = new Anyroute({ apiKey: "k", baseUrl: router.url, sleep: async (ms) => void waits.push(ms) });
    router.state.rateLimitLeft = 1;
    const r = await c.chat.completions.create({ model: "example/model", messages: [] });
    expect(r.id).toBe(V2.claims.rid);
    expect(waits).toEqual([7000]);
  });

  test("429 without retries left throws RateLimitError with retryAfter", async () => {
    const c = new Anyroute({ apiKey: "k", baseUrl: router.url, maxRetries: 0 });
    router.state.rateLimitLeft = 1;
    const e = await c.chat.completions.create({ model: "example/model", messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).toBeInstanceOf(AnyrouteAPIError);
    expect(e.status).toBe(429);
    expect(e.type).toBe("rate_limited");
    expect(e.retryAfter).toBe(7);
  });

  test("404 envelope becomes NotFoundError with the router's type", async () => {
    const e = await client.presets.get("nope").catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.type).toBe("preset_not_found");
  });

  test("parseRetryAfter reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(Date.parse("2026-09-30T12:00:10Z")).toUTCString(), Date.parse("2026-09-30T12:00:00Z"))).toBe(10_000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("embeddings and rerank", () => {
  test("embeddings carry the receipt and lane", async () => {
    const r = await client.embeddings.create({ model: "example/embed", input: "hello" }, { lane: "attested" });
    expect(r.data[0].embedding).toEqual([0.1, 0.2]);
    expect(r.anyroute.receiptId).toBe("gen-emb-1");
    expect(r.anyroute.lane).toBe("attested");
  });

  test("rerank returns results best first", async () => {
    const r = await client.rerank.create({ model: "example/rerank", query: "cats", documents: ["dogs", "cats are great", "fish"], top_n: 2 });
    expect(r.results[0].index).toBe(1);
    expect(r.results).toHaveLength(2);
    expect(r.usage?.search_units).toBe(1);
    expect(r.anyroute.receipt?.id).toBe("gen-rr-1");
  });
});

describe("batches", () => {
  test("create, wait, results", async () => {
    const b = await client.batches.create({ requests: [
      { custom_id: "q1", method: "POST", url: "/v1/chat/completions", body: { model: "example/model", messages: [{ role: "user", content: "2+2?" }] } },
      { custom_id: "q2", method: "POST", url: "/v1/chat/completions", body: { model: "missing/model", messages: [{ role: "user", content: "hi" }] } },
    ] });
    expect(b.status).toBe("validating");
    const polls: string[] = [];
    const { batch, ok, failed, byCustomId } = await client.batches.results(b.id, { pollIntervalMs: 1, onPoll: (x: any) => polls.push(x.status) } as any);
    expect(batch.status).toBe("completed");
    expect(batch.cost.discount_bps).toBe(5000);
    expect(ok[0].response?.body.choices[0].message.content).toBe("4");
    expect(failed[0].error?.code).toBe("model_not_found");
    expect(byCustomId.get("q1")?.response?.status_code).toBe(200);
    expect((await client.batches.list({ limit: 5 })).data).toHaveLength(1);
    expect(last("/api/v1/batches?").path).toBe("/api/v1/batches?limit=5");
    expect((await client.batches.cancel(b.id)).status).toBe("cancelling");
  });
});

describe("presets", () => {
  test("put, get, versions, diff, rollback, delete", async () => {
    const a = await client.presets.put("support-bot", { models: ["example/model"], system_prompt: "Be brief." });
    expect(a.changed).toBe(true);
    expect(a.model).toBe("@preset/support-bot");
    const same = await client.presets.put("support-bot", { models: ["example/model"], system_prompt: "Be brief." });
    expect(same.changed).toBe(false);
    await client.presets.put("support-bot", { models: ["example/open"], system_prompt: "Be brief." });
    expect((await client.presets.get("support-bot")).latest_version).toBe(2);
    expect((await client.presets.list()).map((p) => p.name)).toEqual(["support-bot"]);
    expect((await client.presets.versions("support-bot"))[0].version).toBe(2);
    expect((await client.presets.diff("support-bot", 1, 2)).identical).toBe(false);
    const back = await client.presets.rollback("support-bot", 1);
    expect(back.restored_from).toBe(1);
    expect(back.config.models).toEqual(["example/model"]);
    expect(client.presets.model("support-bot", 3)).toBe("@preset/support-bot@3");
    expect((await client.presets.delete("support-bot")).deleted).toBe(true);
  });
});

describe("models", () => {
  test("filters by lane and output modality", async () => {
    expect((await client.models.list()).length).toBe(3);
    const attested = await client.models.list({ lane: "attested" });
    expect(attested.map((m) => m.id)).toEqual(["example/model"]);
    expect(attested[0].attestation?.best).toBe("attested");
    expect(supportsLane(attested[0], "unlinkable")).toBe(false);
    expect((await client.models.list({ outputModalities: "rerank" })).map((m) => m.id)).toEqual(["example/rerank"]);
  });
});

describe("receipts", () => {
  test("get + verify v1 and v2, and fetchAndVerify with the proof", async () => {
    const r = await client.receipts.get("gen-xyz");
    expect(r.version).toBe(2);
    const v = await client.receipts.verify(r);
    expect(v.valid).toBe(true);
    expect(v.v1?.valid).toBe(true);
    expect(v.v2?.valid).toBe(true);
    const f = await client.receipts.fetchAndVerify("gen-xyz");
    expect(f.valid).toBe(true);
    expect(f.v2?.anchor).toBe("proof_valid");
  });

  test("v2 with the streamed chunks checks the chain head", async () => {
    const v = await verifyReceiptV2(V2.cose, { keys: JWKS as any, chunks: V2.chunks });
    expect(v.valid).toBe(true);
    expect(v.checks.find((c) => c.id === "chain")?.status).toBe("pass");
  });

  test("a tampered v1 payload or v2 signature fails", async () => {
    const r = await client.receipts.get("gen-xyz");
    const badV1: Receipt = { ...r, payload: { ...r.payload, tokens_out: 999 } };
    expect((await client.receipts.verify(badV1)).valid).toBe(false);
    const bytes = Buffer.from(V2.cose, "base64");
    bytes[bytes.length - 1] ^= 1;
    const badV2: Receipt = { ...r, v2: { ...r.v2!, cose: bytes.toString("base64") } };
    const v = await client.receipts.verify(badV2);
    expect(v.valid).toBe(false);
    expect(v.v1?.valid).toBe(true);
    expect(v.v2?.checks.find((c) => c.id === "signature")?.status).toBe("fail");
  });
});

test("reads ANYROUTE_API_KEY and ANYROUTE_BASE_URL from the environment", async () => {
  const before = { k: process.env.ANYROUTE_API_KEY, u: process.env.ANYROUTE_BASE_URL };
  process.env.ANYROUTE_API_KEY = "env-key";
  process.env.ANYROUTE_BASE_URL = `${router.url}/v1/`;
  try {
    const c = new Anyroute({ sleep: noSleep });
    expect(c.baseUrl).toBe(router.url);
    await c.models.list();
    expect(last("/api/v1/models").headers.get("authorization")).toBe("Bearer env-key");
  } finally {
    process.env.ANYROUTE_API_KEY = before.k;
    process.env.ANYROUTE_BASE_URL = before.u;
    if (before.k === undefined) delete process.env.ANYROUTE_API_KEY;
    if (before.u === undefined) delete process.env.ANYROUTE_BASE_URL;
  }
});
