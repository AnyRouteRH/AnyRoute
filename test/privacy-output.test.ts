import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { privacyLabel, shortLine } from "../src/privacy/label.ts";
import { privacyLabel as clientLabel } from "../packages/client/src/privacy.ts";
import { loadConfig } from "../src/config.ts";
import { buildInventory } from "../src/privacy/inventory.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

const hash = "ab".repeat(32);
const base = { id: "output-1", provider: "media-provider", model: "acme/media", mode: "prepaid", lane: "public", disclosure: "vendor-forwarded", request_sha256: hash, response_sha256: hash, cost: "0.01" };
const kinds = { token: "text", image_mp: "image", video_sec: "video", audio_sec: "audio", call: "call", gpu_sec: "compute" } as const;

describe("output labels from signed usage fields", () => {
  for (const [unit_type, kind] of Object.entries(kinds)) test(unit_type, () => {
    const receipt = { payload: { ...base, usage: { units: 2.5, unit_type } } };
    const label = privacyLabel(receipt);
    expect(label.label.output).toMatchObject({ unit_type, units: 2.5, kind });
    expect(clientLabel(receipt)).toEqual(label);
    expect(label.label.prompt_readers.router).toBe(true);
    expect(label.summary).toHaveLength(5);
    for (const line of label.summary) expect(line.length).toBeLessThan(300);
    for (const via of [undefined, "telegram"] as const) {
      expect(shortLine(label, via)).not.toContain("\n");
      expect(shortLine(label, via).length).toBeLessThan(250);
    }
    if (kind !== "text") {
      expect(label.label.stored.fingerprints).toBe(true);
      expect(label.label.stored.text).toContain("hashes of the request and output");
      expect(label.label.stored.text).toContain("does not establish retention");
      expect(label.label.prompt_readers.text).toContain("request text in memory");
    }
    if (["image", "video", "audio"].includes(kind)) {
      expect(label.label.stored.text).toContain(`not the ${kind} itself`);
      expect(label.label.output.text).toContain("does not show that the router fetched");
    }
  });

  test("missing units preserve token labels; malformed and future units carry no retention claims", () => {
    expect(privacyLabel(base).label.output).toMatchObject({ unit_type: "token", units: null, kind: "text" });
    expect(privacyLabel({ ...base, unit_type: "audio_sec" }).label.output.kind).toBe("audio");
    for (const unit_type of ["future_unit", "__proto__", "constructor", "", null, 1, {}]) {
      const receipt = { ...base, usage: { unit_type, units: 0 } };
      const label = privacyLabel(receipt);
      expect(clientLabel(receipt)).toEqual(label);
      expect(label.label.output).toMatchObject({ kind: "unknown", units: 0 });
      expect(label.label.stored).toMatchObject({ prompt_text: null, reply_text: null, client_address: null, cache: "not_recorded" });
      expect(label.label.network.stored).toBeNull();
      expect(label.short).toContain("handling not recorded");
      expect(JSON.stringify(label)).not.toMatch(/no copy|not stored|not saved|never cached/);
    }
    for (const units of [-1, NaN, Infinity, "2", null]) expect(privacyLabel({ usage: { unit_type: "image_mp", units } }).label.output.units).toBeNull();
    const sparse = privacyLabel({ usage: { unit_type: "image_mp", units: 0 } });
    expect(sparse.label.stored.fingerprints).toBe(false);
    expect(sparse.summary[3]).toContain("hashes not recorded");
    expect(sparse.label.stored.records).not.toContain("the provider id");
    expect(privacyLabel({ ...base, response_sha256: "not-a-hash", usage: { unit_type: "image_mp" } }).label.stored.fingerprints).toBe(false);
  });

  test("a call unit alone does not prove search or tool execution", () => {
    const plain = privacyLabel({ ...base, usage: { unit_type: "call", units: 1 } });
    expect(plain.label.output.text).toContain("does not identify the operation");
    expect(plain.label.prompt_readers.text).not.toContain("query text was sent");
    const search = privacyLabel({ ...base, operation: "search", usage: { unit_type: "call", units: 1 } });
    expect(search.label.prompt_readers.text).toContain("query text was sent to the search provider (media-provider)");
    expect(privacyLabel({ operation: "search", usage: { unit_type: "call" } }).label.prompt_readers.text).not.toContain("query text was sent");
  });

  test("cache and batch limits agree with the inventory", () => {
    const inventory = buildInventory();
    expect(inventory.summary.caveats.some((c) => c.title.includes("Batch API"))).toBe(true);
    const cached = privacyLabel({ ...base, mode: "cache", provider: "cache" });
    expect(cached.label.stored.text).toContain("does not cache the prompt itself");
    expect(cached.label.stored.text).toContain("hashed word vector");
    expect(cached.summary[3]).not.toContain("prompt and reply");
    const batch = privacyLabel({ ...base, batch: { id: "batch-1", line: 0 }, usage: { unit_type: "audio_sec", units: 10 } });
    expect(batch.label.stored.text).toContain("kept encrypted");
    expect(batch.summary[3]).toContain("Batch content is kept sealed");
    expect(privacyLabel(base).label.stored.text).toContain("could quote request text");
  });

  test("the real config loader accepts these labels in production without a new flag", () => {
    const config = loadConfig({ NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/fixture", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", PAYMENTS_MODE: "escrow", ESCROW_ADDRESS: "0x" + "1".repeat(40), ESCROW_START_BLOCK: "1", ESCROW_TOKENS: JSON.stringify([{ symbol: "UNIT", address: "0x" + "2".repeat(40), decimals: 18, feed: "0x" + "3".repeat(40) }]) });
    expect(config.env).toBe("production");
    for (const unit_type of Object.keys(kinds)) expect(privacyLabel({ ...base, usage: { unit_type } }, { baseUrl: config.publicUrl }).verify_url).toBe("https://router.example/verify?r=output-1");
  });
});

// Fixtures come from actual route responses, not handwritten copies of their receipt shapes.
// The harness uses fixture providers and a funded ledger; signatures and receipt retrieval are real router code.
describe("labels for receipts produced by every current route", () => {
  let h: Harness;
  let auth: Record<string, string>;
  beforeAll(async () => {
    h = await startRouter({ env: { ANYROUTE_FEATURE_COUNCIL: "true" }, providers: [
      { id: "member-a", name: "Member A", models: [MODELS.llama, MODELS.embed] },
      { id: "member-b", name: "Member B", models: [MODELS.qwen] },
    ] });
    auth = (await h.fundedKey(20n)).auth;
  });
  afterAll(async () => h?.close());

  const routes = [
    ["chat", "/api/v1/chat/completions", { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 30 }],
    ["embeddings", "/api/v1/embeddings", { model: MODELS.embed.slug, input: ["hello", "world"] }],
    ["rag", "/api/v1/rag", { model: MODELS.llama.slug, embedding_model: MODELS.embed.slug, question: "What reaches orbit?", documents: ["Rockets reach orbit.", "Bread rises."], top_k: 1, max_tokens: 30 }],
    ["responses", "/api/v1/responses", { model: MODELS.llama.slug, input: "hello", max_output_tokens: 30 }],
    ["messages", "/v1/messages", { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 30 }],
    ["council", "/api/v1/chat/completions", { model: "anyroute/council", messages: [{ role: "user", content: "hello" }], max_tokens: 30, council: { models: [MODELS.llama.slug, MODELS.qwen.slug], judge: MODELS.llama.slug, mode: "fuse" } }],
  ] as const;
  for (const [name, path, json] of routes) test(name, async () => {
    const response = await h.request(path, { method: "POST", headers: auth, json });
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    const ids = new Set<string>([response.headers.get("x-receipt-id")!]);
    if (name === "rag") for (const call of body.receipts) ids.add(call.receipt_id);
    if (name === "council") for (const member of body.receipt.payload.council.members) if (member.receipt_id) ids.add(member.receipt_id);
    if (name === "rag" || name === "council") expect(ids.size).toBeGreaterThan(1);
    for (const id of ids) {
      expect(id).toStartWith("gen-");
      const fetched = await h.request(`/api/v1/receipts/${id}`);
      expect(fetched.status).toBe(200);
      const fixture = ((await fetched.json()) as any).data;
      expect(await h.ctx.signer.verify(fixture.payload, fixture.sig, fixture.key_id)).toBe(true);
      const expected = privacyLabel(fixture, { baseUrl: h.ctx.cfg.publicUrl });
      const endpoint = await h.request(`/api/v1/receipts/${id}/privacy`);
      expect(endpoint.status).toBe(200);
      const label = ((await endpoint.json()) as any).data;
      expect(label).toEqual(expected);
      expect(clientLabel(fixture, { baseUrl: h.ctx.cfg.publicUrl })).toEqual(label);
      expect(label.label.output).toMatchObject({ unit_type: "token", kind: "text" });
      expect(label.label.prompt_readers.router).toBe(true);
      if (fixture.payload.council?.role === "judge") {
        expect(label.label.prompt_readers.text).toContain("member-a, member-b");
        expect(label.short).toContain("council members + judge");
        expect(label.label.prompt_readers.participants).toEqual(["member-a", "member-b"]);
      } else if (fixture.payload.council?.role === "member") {
        expect(label.label.prompt_readers.participants).toBeUndefined();
        expect(label.short).not.toContain("council members + judge");
      }
    }
  });
});
