import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { generations, providers } from "../src/db/schema.ts";
import { encrypt } from "../src/lib/util.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runRegistry } from "../src/services/registry.ts";
import { keysetDigest } from "../src/providers/aci.ts";
import { buyTokens } from "../src/blind/client.ts";
import { authorizationHeader, decodeBase64 } from "../src/blind/privacy-token.ts";
import { ONION_HEADER } from "../src/lib/onion.ts";
import { privacyLabel, shortLine, type PrivacyLabel } from "../src/privacy/label.ts";
import { fetchPrivacyLabel, privacyLabel as clientLabel, privacyPath, shortLine as clientShortLine } from "../packages/client/src/privacy.ts";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { CLAIMS_OK, RECEIPT_KEY, gatewayReport, keyset, phalaVerifierAnswer, session, signedReceipt, type ReportOptions } from "./aci-fixtures.ts";

setDefaultTimeout(60_000);

// "What we saw" (src/privacy/label.ts): the plain-English privacy label computed from a signed receipt. The first half
// checks the pure function on every lane and payment combination; the second half runs real requests through the router
// (an attested gateway, a plain provider, the unlinkable lane over Tor with a blind token, a withheld reply, a legacy
// receipt) and reads the label back through GET /api/v1/receipts/{id}/privacy.

const KEY_HASH = "0x" + "ab".repeat(32);
const WALLET = "0x" + "cd".repeat(20);
const NULLIFIER = "ef".repeat(32);
const GATEWAY_UA = { kind: "aci/1", receipt_verified: true, attested: true, gpu_attested: true, claims: { tee_attested: { status: "asserted", source: "hardware_proven" } } };
const UNPROVEN_UA = { kind: "aci/1", receipt_verified: true, attested: false, gpu_attested: false, reason: "tee_attested is not asserted" };

const base = { v: 1, id: "gen-fixture-1", router: "https://router.example", model: "acme/chat", provider: "vendor", mode: "prepaid", payer: KEY_HASH, payment_tx: null, disclosure: "vendor-forwarded", lane: "public" };
const receipt = (over: Record<string, unknown> = {}) => ({ payload: { ...base, ...over }, sig: "x", key_id: "y" });

/** Every text a label puts in front of a reader. */
const allText = (l: PrivacyLabel) => JSON.stringify([l.summary, l.short, l.label.prompt_readers.text, l.label.network.text, l.label.payment.text, l.label.stored.text, l.label.hardware.text]);
/** Wording that says an enclave answered. */
const CLAIMS_ENCLAVE = /proven enclave|provider's attested enclave|Attested hardware|Hardware: attested/;
const BANNED = /\b(private|no logs?|untraceable|anonymous|demo|mock|placeholder|simulated|guarantee[sd]?)\b|cannot read|can't read|cannot see your prompt/i;

describe("the label, from a receipt alone", () => {
  test("public lane, paid from a key: the provider reads it, the address is seen but not kept, no hardware", () => {
    const l = privacyLabel(receipt());
    expect(l.receipt_id).toBe("gen-fixture-1");
    expect(l.lane).toBe("public");
    expect(l.label.prompt_readers).toMatchObject({ router: true, provider: { id: "vendor", access: "provider", reply_withheld: false } });
    expect(l.label.prompt_readers.text).toContain("router read the prompt in memory to route it");
    expect(l.label.prompt_readers.text).toContain("may keep or log it under its own terms");
    expect(l.label.network).toMatchObject({ hidden: false, via: null, stored: false, counter: "none" });
    expect(l.label.network.text).toContain("saw the network address");
    expect(l.label.network.text).toContain("does not write it to the generation record, the receipt or any other table");
    expect(l.label.network.text).toContain("rate-limited per key");
    expect(l.label.payment).toMatchObject({ kind: "key_balance", identifies: "api_key" });
    expect(l.label.stored).toMatchObject({ prompt_text: false, reply_text: false, client_address: false, fingerprints: true, linked_to: "api_key", cache: "only_if_requested", public_by_id: true });
    expect(l.label.stored.records.join(" ")).toContain("app name");
    expect(l.label.hardware).toMatchObject({ attested: false, tee: null, gpu_attested: false, verified_by: null, development_report: false });
    expect(l.summary).toHaveLength(5);
    expect(l.short).toBe("Read by: router + provider · IP: seen, not saved · Paid: API key balance");
    expect(l.verify_url).toBe("https://router.example/verify?r=gen-fixture-1");
  });

  test("attested lane, paid from a key, a provider the router attested itself: a proven enclave, the TEE named by the router's record", () => {
    const r = receipt({ lane: "attested", disclosure: "attested", provider: "tdx-box", attestation: "0x" + "12".repeat(32) });
    const l = privacyLabel(r, { teeKind: "tdx" });
    expect(l.label.prompt_readers.provider).toMatchObject({ id: "tdx-box", access: "attested_enclave", reply_withheld: false });
    expect(l.label.hardware).toMatchObject({ attested: true, tee: "Intel TDX", gpu_attested: false, verified_by: "router_attestation", development_report: false });
    expect(l.label.hardware.text).toContain("shows what the provider was running, not what its software did with the prompt");
    expect(l.label.stored.cache).toBe("never");
    expect(l.label.network.hidden).toBe(false);
    expect(l.short).toBe("Read by: router + proven enclave · IP: seen, not saved · Paid: API key balance");
    // The receipt does not name the TEE, so without the router's record the label does not either.
    const bare = privacyLabel(r);
    expect(bare.label.hardware).toMatchObject({ attested: true, tee: null });
    expect(bare.summary[4]).toBe("Hardware: attested, checked by the router before it routed the request.");
  });

  test("attested lane through an attested gateway: its signed receipt is what was checked, and GPU attestation is only claimed when asserted", () => {
    const l = privacyLabel(receipt({ lane: "attested", disclosure: "attested", provider: "gw", upstream_attestation: GATEWAY_UA }), { teeKind: "tdx" });
    expect(l.label.hardware).toMatchObject({ attested: true, tee: "Intel TDX", gpu_attested: true, verified_by: "gateway_receipt" });
    expect(l.summary[4]).toBe("Hardware: attested (Intel TDX with GPU attestation), checked from the gateway's signed receipt.");
    const cpuOnly = privacyLabel(receipt({ lane: "attested", disclosure: "attested", provider: "gw", upstream_attestation: { ...GATEWAY_UA, gpu_attested: false } }), { teeKind: "tdx" });
    expect(cpuOnly.label.hardware.gpu_attested).toBe(false);
    expect(cpuOnly.summary[4]).toBe("Hardware: attested (Intel TDX), checked from the gateway's signed receipt.");
  });

  test("unlinkable lane, paid with a blind token: the address is hidden, nobody is named, nothing links the spend to an account", () => {
    const r = receipt({ lane: "unlinkable", disclosure: "attested", mode: "blind", payer: null, nullifier: NULLIFIER, token_key_id: "k1", provider: "gw", upstream_attestation: GATEWAY_UA });
    const tor = privacyLabel(r, { teeKind: "tdx", unlinkableTransports: ["onion"] });
    expect(tor.lane).toBe("unlinkable");
    expect(tor.label.network).toMatchObject({ hidden: true, via: "tor", stored: false, counter: "none" });
    expect(tor.label.network.text).toContain("AnyRoute did not see your network address");
    expect(tor.label.network.text).toContain("over Tor");
    expect(tor.label.network.text).toContain("refused before it is served");
    expect(tor.label.payment).toMatchObject({ kind: "blind_token", identifies: "spent_token" });
    expect(tor.label.payment.text).toContain("names no account, key or wallet");
    expect(tor.label.payment.text).toContain("timing and size of purchases and spends can still hint at a link");
    expect(tor.label.stored).toMatchObject({ linked_to: "nobody", cache: "never" });
    expect(tor.label.stored.records.join(" ")).not.toContain("app name");
    expect(tor.label.stored.records.join(" ")).toContain("spent token");
    expect(tor.label.prompt_readers.text).toContain("router read the prompt in memory");
    expect(tor.summary[1]).toBe("Your IP address: hidden from AnyRoute. This lane only takes requests that arrive over Tor.");
    expect(tor.short).toBe("Read by: router + proven enclave · IP: hidden (Tor) · Paid: blind token, no account");
    // The label follows how the router serves the lane; unknown or both, it says both.
    expect(privacyLabel(r, { unlinkableTransports: ["ohttp"] }).short).toContain("IP: hidden (relay)");
    expect(privacyLabel(r, { unlinkableTransports: ["ohttp", "onion"] }).short).toContain("IP: hidden (Tor or relay)");
    expect(privacyLabel(r).short).toContain("IP: hidden (Tor or relay)");
    expect(privacyLabel(r).summary[1]).toContain("over Tor or through an independent relay");
  });

  test("a reply the router withheld: the provider read the prompt, the enclave was not proven, and the label says the reply was withheld", () => {
    const r = receipt({ lane: "attested", disclosure: "policy", provider: "gw", upstream_attestation: UNPROVEN_UA });
    const l = privacyLabel(r, { teeKind: "tdx" });
    expect(l.label.prompt_readers.provider).toMatchObject({ id: "gw", access: "unproven_provider", reply_withheld: true });
    expect(l.label.prompt_readers.text).toContain("read it and produced a reply");
    expect(l.label.prompt_readers.text).toContain("tee_attested is not asserted");
    expect(l.label.prompt_readers.text).toContain("withheld the reply from the caller");
    expect(l.label.hardware).toMatchObject({ attested: false, tee: null, gpu_attested: false, verified_by: null });
    expect(l.label.hardware.text).toContain("Not proven");
    expect(l.summary[0]).toBe("Read by: AnyRoute's router and the provider (gw), which could not be shown to be an enclave, so the reply was withheld.");
    expect(l.summary[4]).toBe("Hardware: not proven. Reason recorded: tee_attested is not asserted.");
    expect(l.short).toBe("Read by: router + unproven provider (reply withheld) · IP: seen, not saved · Paid: API key balance");
    expect(allText(l)).not.toMatch(CLAIMS_ENCLAVE);
    // The same receipt on the public lane does not show whether the reply was delivered, and the label does not say.
    const pub = privacyLabel(receipt({ lane: "public", disclosure: "policy", provider: "gw", upstream_attestation: UNPROVEN_UA }));
    expect(pub.label.prompt_readers.provider).toMatchObject({ access: "unproven_provider", reply_withheld: null });
    expect(pub.label.prompt_readers.text).not.toContain("withheld");
    // A `:private` model route is held to the attested rule whatever its lane says.
    expect(privacyLabel(receipt({ lane: "public", private: true, disclosure: "policy", upstream_attestation: UNPROVEN_UA })).label.prompt_readers.provider.reply_withheld).toBe(true);
  });

  test("a legacy receipt missing fields says what it does not record and never assumes the favourable answer", () => {
    const l = privacyLabel({ payload: { v: 1, id: "gen-old-1", provider: "old-provider", model: "acme/chat", cost: "0.001" }, sig: "x", key_id: "y" });
    expect(l.receipt_id).toBe("gen-old-1");
    expect(l.lane).toBeNull();
    expect(l.label.prompt_readers.provider).toMatchObject({ id: "old-provider", access: "unknown" });
    expect(l.label.prompt_readers.text).toContain("does not record how that provider handles prompts");
    expect(l.label.network).toMatchObject({ hidden: false, counter: "possible" });
    expect(l.label.network.text).toContain("does not record a lane, so the label assumes the address was visible");
    expect(l.label.payment).toMatchObject({ kind: "unknown", identifies: null });
    expect(l.label.payment.text).toContain("does not record how this call was paid");
    expect(l.label.stored).toMatchObject({ linked_to: "unknown", cache: "only_if_requested" });
    expect(l.label.hardware).toMatchObject({ attested: false });
    expect(l.label.hardware.text).toContain("does not record whether");
    expect(l.summary).toHaveLength(5);
    expect(l.summary[2]).toBe("Paid with: not recorded in this receipt.");
    expect(l.short).toBe("Read by: router + provider · IP: seen, may be held ~1 min for rate limits · Paid: not recorded");
    expect(l.verify_url).toBeNull(); // no router recorded, and none given
    // With the router's own address it can link to the verify page.
    expect(privacyLabel({ payload: { id: "gen-old-1" } }, { baseUrl: "https://r.example/" }).verify_url).toBe("https://r.example/verify?r=gen-old-1");
    // Nothing at all still produces a label.
    for (const junk of [null, undefined, 5, "x", [], {}, { payload: 5 }, { payload: { lane: 3, mode: {}, provider: [] } }]) {
      const j = privacyLabel(junk);
      expect(j.summary).toHaveLength(5);
      expect(j.label.hardware.attested).toBe(false);
      expect(j.label.payment.kind).toBe("unknown");
    }
  });

  test("every payment field the receipt can carry", () => {
    const pay = (over: Record<string, unknown>) => privacyLabel(receipt(over)).label.payment;
    expect(pay({ mode: "prepaid" })).toMatchObject({ kind: "key_balance", identifies: "api_key" });
    expect(pay({ mode: "paywith", paid_with: { token: "NVDA" } })).toMatchObject({ kind: "pay_with_stock_token", identifies: "api_key" });
    expect(pay({ mode: "byok" })).toMatchObject({ kind: "own_provider_key", identifies: "api_key" });
    expect(pay({ mode: "blind", payer: null, nullifier: NULLIFIER })).toMatchObject({ kind: "blind_token", identifies: "spent_token" });
    expect(pay({ mode: "per_call", payer: WALLET })).toMatchObject({ kind: "wallet_balance", identifies: "wallet" });
    expect(pay({ mode: "per_call", payer: WALLET, payment_tx: "0x" + "77".repeat(32) })).toMatchObject({ kind: "x402", identifies: "wallet" });
    expect(pay({ mode: "per_call", payer: WALLET, payment_tx: "0x" + "77".repeat(32) }).text).toContain("public on the chain");
    const byok = privacyLabel(receipt({ mode: "byok" }));
    expect(byok.label.prompt_readers.text).toContain("your own key with the provider (vendor), so the provider (vendor) can tie it to your account with them");
    expect(byok.short).toContain("Paid: own provider key");
    // A wallet or a blind token on the public lane has no key to rate-limit by: the address is a counter key for about a minute.
    for (const over of [{ mode: "per_call", payer: WALLET }, { mode: "blind", payer: null, nullifier: NULLIFIER }]) {
      const l = privacyLabel(receipt(over));
      expect(l.label.network.counter).toBe("about_a_minute");
      expect(l.label.network.text).toContain("expires about a minute later");
      expect(l.short).toContain("IP: seen, held ~1 min for rate limits");
    }
    // A cache hit: only the router read the request, nothing was charged, and a copy is held until it expires.
    const hit = privacyLabel(receipt({ mode: "cache", provider: "cache", cost: "0", cache: { similarity: 1, original: "gen-0" } }));
    expect(hit.label.prompt_readers.provider).toMatchObject({ access: "none", reply_withheld: false });
    expect(hit.label.payment).toMatchObject({ kind: "cache_hit", identifies: "api_key" });
    expect(hit.label.stored.cache).toBe("cache_hit");
    expect(hit.label.hardware).toMatchObject({ attested: false, verified_by: null });
    expect(hit.short).toBe("Read by: router only (cache) · IP: seen, may be held ~1 min for rate limits · Paid: nothing (cache)");
  });

  test("a documented policy is not hardware, and a development report is never called attested", () => {
    const policy = privacyLabel(receipt({ disclosure: "policy", lane: "public" }));
    expect(policy.label.prompt_readers.provider.access).toBe("documented_policy");
    expect(policy.label.prompt_readers.text).toContain("hardware does not prove it");
    expect(policy.label.hardware.attested).toBe(false);
    expect(policy.short).toContain("router + provider (policy, unproven)");
    const dev = privacyLabel(receipt({ lane: "attested", disclosure: "attested", attestation: "0x1", attestation_simulated: true }), { teeKind: "dev" });
    expect(dev.label.hardware).toMatchObject({ attested: false, development_report: true, tee: null });
    expect(dev.label.prompt_readers.provider.access).toBe("unproven_provider");
    expect(dev.summary[4]).toBe("Hardware: a development report only, not real hardware.");
    expect(allText(dev)).not.toMatch(CLAIMS_ENCLAVE);
  });

  test("text from the receipt cannot inject anything into a sentence", () => {
    const l = privacyLabel(receipt({ id: "gen 1<script>", provider: "a b<script>alert(1)</script>", lane: "attested", disclosure: "policy", upstream_attestation: { attested: false, reason: "bad\nline\u0000 " + "x".repeat(500) } }), { baseUrl: "javascript:alert(1)" });
    expect(l.receipt_id).toBeNull();
    expect(l.verify_url).toBeNull();
    expect(l.label.prompt_readers.provider.id).toBeNull();
    expect(allText(l)).not.toContain("<script>");
    expect(l.label.hardware.text).not.toMatch(/[\u0000-\u001f]/);
    expect(l.label.hardware.text.length).toBeLessThan(400);
    expect(privacyLabel(receipt(), { teeKind: "<b>x</b>" }).label.hardware.tee).toBeNull(); // only an attested answer names a TEE
  });

  test("the envelope and the bare payload give the same label, and nothing a label says is a claim the router cannot back", () => {
    const r = receipt({ lane: "attested", disclosure: "attested", upstream_attestation: GATEWAY_UA });
    expect(privacyLabel(r.payload)).toEqual(privacyLabel(r));
    const combos: Record<string, unknown>[] = [
      {},
      { lane: "attested", disclosure: "attested", upstream_attestation: GATEWAY_UA },
      { lane: "unlinkable", disclosure: "attested", mode: "blind", payer: null, nullifier: NULLIFIER, upstream_attestation: GATEWAY_UA },
      { lane: "attested", disclosure: "policy", upstream_attestation: UNPROVEN_UA },
      { mode: "per_call", payer: WALLET, payment_tx: "0x" + "77".repeat(32) },
      { mode: "cache", provider: "cache" },
      { lane: undefined, mode: undefined, disclosure: undefined },
    ];
    for (const c of combos) {
      const l = privacyLabel(receipt(c), { unlinkableTransports: ["onion"] });
      expect(l.summary.length).toBeGreaterThanOrEqual(3);
      expect(l.summary.length).toBeLessThanOrEqual(5);
      for (const line of l.summary) expect(line.length).toBeLessThan(200);
      expect(allText(l)).not.toMatch(BANNED);
      // The router always reads the prompt; no lane says otherwise.
      expect(l.label.prompt_readers.router).toBe(true);
      expect(l.label.stored).toMatchObject({ prompt_text: false, reply_text: false, client_address: false });
    }
  });
});

describe("the same label on the client", () => {
  const matrix: [Record<string, unknown>, Parameters<typeof privacyLabel>[1]][] = [
    [{}, {}],
    [{ usage: { unit_type: "token", units: 2 } }, {}],
    [{ usage: { unit_type: "image_mp", units: 2 } }, {}],
    [{ usage: { unit_type: "video_sec", units: 2 } }, {}],
    [{ usage: { unit_type: "audio_sec", units: 2 } }, {}],
    [{ usage: { unit_type: "call", units: 2 } }, {}],
    [{ usage: { unit_type: "gpu_sec", units: 2 } }, {}],
    [{ usage: { unit_type: "future_unit", units: 2 } }, {}],
    [{ lane: "attested", disclosure: "attested", attestation: "0x1" }, { teeKind: "tdx" }],
    [{ lane: "attested", disclosure: "attested", provider: "gw", upstream_attestation: GATEWAY_UA }, { teeKind: "snp" }],
    [{ lane: "unlinkable", disclosure: "attested", mode: "blind", payer: null, nullifier: NULLIFIER, upstream_attestation: GATEWAY_UA }, { unlinkableTransports: ["onion"] }],
    [{ lane: "unlinkable", disclosure: "attested", mode: "blind", payer: null, nullifier: NULLIFIER }, { unlinkableTransports: ["ohttp", "onion"], baseUrl: "https://other.example" }],
    [{ lane: "attested", disclosure: "policy", upstream_attestation: UNPROVEN_UA }, {}],
    [{ mode: "per_call", payer: WALLET, payment_tx: "0x" + "77".repeat(32) }, {}],
    [{ mode: "paywith" }, {}],
    [{ mode: "byok" }, {}],
    [{ mode: "cache", provider: "cache" }, {}],
    [{ attestation_simulated: true, disclosure: "attested", lane: "attested" }, { teeKind: "dev" }],
    [{ lane: undefined, mode: undefined, disclosure: undefined, provider: undefined, id: undefined }, {}],
  ];

  test("privacyLabel gives the router's label byte for byte, and the shared source is identical", () => {
    for (const [over, opts] of matrix) {
      const r = receipt(over);
      expect(clientLabel(r, opts)).toEqual(privacyLabel(r, opts));
      expect(clientShortLine(privacyLabel(r, opts), "telegram")).toBe(shortLine(privacyLabel(r, opts), "telegram"));
    }
    const shared = (path: string) => {
      const src = readFileSync(new URL(path, import.meta.url), "utf8");
      return src.slice(src.indexOf("// ==== shared with packages/client/src/privacy.ts: everything"), src.indexOf("// ==== shared with packages/client/src/privacy.ts (end)"));
    };
    const server = shared("../src/privacy/label.ts");
    expect(server.length).toBeGreaterThan(5000);
    expect(shared("../packages/client/src/privacy.ts")).toBe(server);
  });

  test("the fetch helper reads the router's endpoint, with or without the data wrapper, and refuses anything malformed", async () => {
    const label = privacyLabel(receipt());
    const seen: string[] = [];
    const serve = (body: unknown, status = 200) => (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    expect(privacyPath("gen a/b")).toBe("/api/v1/receipts/gen%20a%2Fb/privacy");
    expect(await fetchPrivacyLabel("https://router.example/", "gen-fixture-1", serve({ data: label }))).toEqual(label);
    expect(await fetchPrivacyLabel("https://router.example", "gen-fixture-1", serve(label))).toEqual(label);
    expect(seen).toEqual(["https://router.example/api/v1/receipts/gen-fixture-1/privacy", "https://router.example/api/v1/receipts/gen-fixture-1/privacy"]);
    await expect(fetchPrivacyLabel("https://router.example", "nope", serve({ error: { type: "not_found" } }, 404))).rejects.toThrow(/failed with 404/);
    await expect(fetchPrivacyLabel("https://router.example", "x", serve({ data: { summary: "no" } }))).rejects.toThrow(/malformed/);
    await expect(fetchPrivacyLabel("https://router.example", "x", serve(null))).rejects.toThrow(/malformed/);
  });
});

describe("the OpenAPI document", () => {
  const spec = JSON.parse(readFileSync(new URL("../web/public/openapi.json", import.meta.url), "utf8"));
  const resolve = (node: any): any => (node && typeof node.$ref === "string" ? node.$ref.replace(/^#\//, "").split("/").reduce((n: any, k: string) => n[k], spec) : node);

  /** A small structural check of a value against a schema: types, enums, consts, required keys, and no key the schema does not list. */
  function conforms(value: unknown, schema: any, at = "label"): string[] {
    const s = resolve(schema);
    const errors: string[] = [];
    const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
    if (types.length && !types.includes(kind)) return [`${at}: ${kind} is not ${types.join("|")}`];
    if (s.enum && !s.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
    if ("const" in s && value !== s.const) errors.push(`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(s.const)}`);
    if (kind === "array") {
      if (s.minItems !== undefined && (value as unknown[]).length < s.minItems) errors.push(`${at}: too few items`);
      if (s.maxItems !== undefined && (value as unknown[]).length > s.maxItems) errors.push(`${at}: too many items`);
      (value as unknown[]).forEach((v, i) => errors.push(...conforms(v, s.items, `${at}[${i}]`)));
    }
    if (kind === "object" && s.properties) {
      for (const k of s.required ?? []) if (!(k in (value as object))) errors.push(`${at}: missing ${k}`);
      for (const [k, v] of Object.entries(value as object)) {
        if (!s.properties[k]) errors.push(`${at}: ${k} is not in the schema`);
        else errors.push(...conforms(v, s.properties[k], `${at}.${k}`));
      }
    }
    return errors;
  }

  test("documents the endpoint as public and the label schema matches what the function returns", () => {
    const op = spec.paths["/api/v1/receipts/{id}/privacy"].get;
    expect(op.tags).toEqual(["Receipts"]);
    expect(op.security).toBeUndefined();
    expect(op.responses["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
    expect(op.responses["200"].content["application/json"].schema.properties.data).toEqual({ $ref: "#/components/schemas/PrivacyLabel" });
    expect(spec.components.schemas.Receipt.properties.privacy.$ref).toBe("#/components/schemas/PrivacyLabel");
    const ids: string[] = [];
    JSON.stringify(spec, (k, v) => (k === "operationId" ? (ids.push(v), v) : v));
    expect(new Set(ids).size).toBe(ids.length);
    const matrix: [Record<string, unknown>, Parameters<typeof privacyLabel>[1]][] = [
      [{}, {}],
    [{ usage: { unit_type: "token", units: 2 } }, {}],
    [{ usage: { unit_type: "image_mp", units: 2 } }, {}],
    [{ usage: { unit_type: "video_sec", units: 2 } }, {}],
    [{ usage: { unit_type: "audio_sec", units: 2 } }, {}],
    [{ usage: { unit_type: "call", units: 2 } }, {}],
    [{ usage: { unit_type: "gpu_sec", units: 2 } }, {}],
    [{ usage: { unit_type: "future_unit", units: 2 } }, {}],
      [{ lane: "attested", disclosure: "attested", provider: "gw", upstream_attestation: GATEWAY_UA }, { teeKind: "tdx" }],
      [{ lane: "unlinkable", disclosure: "attested", mode: "blind", payer: null, nullifier: NULLIFIER }, { unlinkableTransports: ["onion"] }],
      [{ lane: "attested", disclosure: "policy", upstream_attestation: UNPROVEN_UA }, {}],
      [{ lane: "public", disclosure: "policy", upstream_attestation: UNPROVEN_UA }, {}],
      [{ mode: "per_call", payer: WALLET, payment_tx: "0x" + "77".repeat(32) }, {}],
      [{ mode: "paywith" }, {}],
      [{ mode: "byok" }, {}],
      [{ mode: "cache", provider: "cache" }, {}],
      [{ attestation_simulated: true, disclosure: "attested", lane: "attested" }, {}],
      [{ lane: undefined, mode: undefined, disclosure: undefined, provider: undefined, id: undefined }, {}],
    ];
    for (const [over, opts] of matrix) expect(conforms(privacyLabel(receipt(over), opts), spec.components.schemas.PrivacyLabel)).toEqual([]);
  });

  test("the developer docs describe the label in the router's own terms", () => {
    const docs = readFileSync(new URL("../web/app/docs/page.jsx", import.meta.url), "utf8");
    expect(docs).toContain('id="what-we-saw"');
    expect(docs).toContain("/api/v1/receipts/&#123;id&#125;/privacy");
    expect(docs).toContain("privacyLabel");
    expect(docs).toContain("/verify/?r=");
  });
});

// ---- through the router ------------------------------------------------------------------------------------------

const GW_MODEL = "acme/attested-chat";
const PLAIN = { id: "plain", slug: "lanetest/plain-chat", prompt: "0.0000001", completion: "0.0000002" };
const ADDRESS = "a2w2k7bgvjopikpj6lakthr6jjbnv3gul7cmsvoxye4zvnbcplunvlyd.onion";
const SECRET = "privacy-label-proxy-secret-0123456789abcdef";
const PROXY_PEER = { requestIP: () => ({ address: "10.20.30.40" }) };
const claim = { source: "https://gateway.example/terms", as_of: "2025-01-15" };

type GwState = { report: ReportOptions; upstream: "verified" | "routed" };
let gw: ReturnType<typeof Bun.serve>;
let verifier: ReturnType<typeof Bun.serve>;
let h: Harness;
let auth: Record<string, string>;
let state: GwState = { report: {}, upstream: "verified" };
const receipts = new Map<string, unknown>();
const sessions = new Map<string, unknown>();
let seq = 0;

const shim = (): typeof fetch =>
  (async (input: unknown, init?: RequestInit) => {
    const u = new URL(String(input), "http://router.test");
    return h.app.request(u.pathname + u.search, init);
  }) as never;

describe("the label through the router", () => {
  beforeAll(async () => {
    const enc = new TextEncoder();
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
          const bytes = enc.encode(JSON.stringify({ id: "chatcmpl-gw", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "hello from the gateway" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
          const id = `rcpt-${++seq}`;
          const servedAt = Math.floor(Date.now() / 1000);
          const s = session(CLAIMS_OK, servedAt);
          sessions.set(s.id, s.doc);
          const upstream = state.upstream === "verified" ? { result: "verified", required: true, session_id: s.id, claims: CLAIMS_OK } : { result: "failed", required: false };
          receipts.set(id, signedReceipt({ keysetDigest: keysetDigest(state.report.keyset ?? keyset()), receiptId: id, requestBody: reqBytes, responseBody: bytes, upstream, servedAt, key: RECEIPT_KEY, model: body.model }));
          return new Response(bytes, { headers: { "content-type": "application/json", "x-receipt-id": id } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => Response.json(phalaVerifierAnswer(((await req.json()) as { hex: string }).hex, true)) });
    h = await startRouter({
      providers: [{ id: "vendor", name: "Vendor", models: [PLAIN] }],
      env: { ATTESTATION_VERIFIERS: "phala", PHALA_VERIFIER_URL: `http://127.0.0.1:${verifier.port}/verify`, ANYROUTE_FEATURE_BLIND: "true", BLIND_PURCHASE_RPM: "1000", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET, UNLINKABLE_VIA_ONION: "true" },
    });
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
      staticModels: [model(GW_MODEL, "Attested chat")],
    });
    await runRegistry(h.ctx);
    const r = await h.request("/api/v1/disclosure/gw", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
    expect(r.status).toBe(200);
    auth = (await h.fundedKey(20n)).auth;
    const { results } = await runAttestor(h.ctx);
    expect((results as { provider: string; ok: boolean }[]).find((x) => x.provider === "gw")).toMatchObject({ ok: true });
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => {
    gw.stop(true);
    verifier.stop(true);
    await h.close();
  });
  beforeEach(() => {
    state = { report: {}, upstream: "verified" };
  });

  const chat = (body: Record<string, unknown> = {}) => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: GW_MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 16, ...body } });
  const privacy = async (id: string) => {
    const res = await h.request(`/api/v1/receipts/${encodeURIComponent(id)}/privacy`); // no credentials: receipts are public by id
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: PrivacyLabel }).data;
  };

  test("public lane, paid from a key, a provider with no attestation", async () => {
    const r = await chat({ model: PLAIN.slug });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.receipt.payload).toMatchObject({ lane: "public", disclosure: "vendor-forwarded", mode: "prepaid", provider: "vendor" });
    const l = await privacy(j.id);
    expect(l).toMatchObject({ receipt_id: j.id, lane: "public" });
    expect(l.verify_url).toBe(`${h.ctx.cfg.publicUrl}/verify?r=${j.id}`);
    expect(l.label.prompt_readers.provider).toMatchObject({ id: "vendor", access: "provider" });
    expect(l.label.network).toMatchObject({ hidden: false, counter: "none", stored: false });
    expect(l.label.payment).toMatchObject({ kind: "key_balance", identifies: "api_key" });
    expect(l.label.stored).toMatchObject({ prompt_text: false, reply_text: false, client_address: false, linked_to: "api_key", cache: "only_if_requested" });
    expect(l.label.hardware.attested).toBe(false);
    expect(l.summary).toHaveLength(5);
    expect(l).toEqual(privacyLabel(j.receipt, { unlinkableTransports: ["onion"], baseUrl: h.ctx.cfg.publicUrl }));
  });

  test("attested lane, paid from a key, through the attested gateway: a proven enclave, GPU asserted, the TEE from the router's record", async () => {
    const r = await chat({ provider: { lane: "attested" } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.receipt.payload).toMatchObject({ lane: "attested", disclosure: "attested", mode: "prepaid", provider: "gw", upstream_attestation: { attested: true, gpu_attested: true } });
    const l = await privacy(j.id);
    expect(l.lane).toBe("attested");
    expect(l.label.prompt_readers.provider).toMatchObject({ id: "gw", access: "attested_enclave", reply_withheld: false });
    expect(l.label.hardware).toMatchObject({ attested: true, tee: "Intel TDX", gpu_attested: true, verified_by: "gateway_receipt" });
    expect(l.label.stored.cache).toBe("never");
    expect(l.label.network.hidden).toBe(false);
    expect(l.summary[4]).toBe("Hardware: attested (Intel TDX with GPU attestation), checked from the gateway's signed receipt.");
    expect(l.short).toBe("Read by: router + proven enclave · IP: seen, not saved · Paid: API key balance");
  });

  test("unlinkable lane over Tor, paid with a blind token: the address is hidden and no account is named", async () => {
    const api = await h.fundedKey(2n);
    const [token] = (await buyTokens({ baseUrl: "http://router.test", apiKey: api.secret, denomination: 10_000, count: 1, fetch: shim() })).tokens;
    const res = await h.app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: { "content-type": "application/json", [ONION_HEADER]: SECRET, authorization: authorizationHeader(decodeBase64(token)!) }, body: JSON.stringify({ model: GW_MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 16, provider: { lane: "unlinkable" } }) },
      PROXY_PEER,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.receipt.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested", mode: "blind", payer: null });
    const l = await privacy(j.id);
    expect(l.lane).toBe("unlinkable");
    expect(l.label.network).toMatchObject({ hidden: true, via: "tor", counter: "none" });
    expect(l.label.payment).toMatchObject({ kind: "blind_token", identifies: "spent_token" });
    expect(l.label.stored).toMatchObject({ linked_to: "nobody", cache: "never" });
    expect(l.label.hardware).toMatchObject({ attested: true, verified_by: "gateway_receipt" });
    expect(l.short).toBe("Read by: router + proven enclave · IP: hidden (Tor) · Paid: blind token, no account");
    expect(JSON.stringify(l)).not.toContain(api.secret);
    // Nothing that names the payer is in the record either: no key, no account.
    const [g] = await h.ctx.db.select().from(generations).where(eq(generations.id, j.id));
    expect(g.keyHash).toBeNull();
  });

  test("a withheld reply: the provider had read the prompt, the enclave was not proven, the reply was not delivered", async () => {
    state.upstream = "routed";
    const r = await chat({ provider: { lane: "attested" } });
    expect(r.status).toBe(502);
    const j = (await r.json()) as any;
    expect(j.error.type).toBe("upstream_not_attested");
    expect(j.choices).toBeUndefined();
    const l = await privacy(j.id);
    expect(l.lane).toBe("attested");
    expect(l.label.prompt_readers.provider).toMatchObject({ id: "gw", access: "unproven_provider", reply_withheld: true });
    expect(l.label.hardware).toMatchObject({ attested: false, verified_by: null });
    expect(l.label.hardware.text).toContain("did not show an attested upstream");
    expect(l.summary[0]).toContain("so the reply was withheld");
    expect(allText(l)).not.toMatch(CLAIMS_ENCLAVE);
  });

  test("a legacy receipt missing fields, and a row with no receipt at all", async () => {
    const old = { v: 1, id: "gen-legacy-1", issued: "2025-01-01T00:00:00.000Z", model: PLAIN.slug, provider: "vendor", cost: "0.000001", tokens: { prompt: 3, completion: 4 } };
    await h.ctx.db.insert(generations).values({ id: "gen-legacy-1", modelId: PLAIN.slug, providerId: "vendor", mode: "prepaid", receiptId: "gen-legacy-1", receipt: old });
    await h.ctx.db.insert(generations).values({ id: "gen-legacy-2", modelId: PLAIN.slug, providerId: "vendor", mode: "prepaid" });
    const l = await privacy("gen-legacy-1");
    expect(l).toMatchObject({ receipt_id: "gen-legacy-1", lane: null });
    expect(l.label.prompt_readers.provider).toMatchObject({ id: "vendor", access: "unknown" });
    expect(l.label.payment.kind).toBe("unknown");
    expect(l.label.hardware.attested).toBe(false);
    expect(l.label.network.text).toContain("does not record a lane");
    expect(l.summary).toHaveLength(5);
    const empty = await privacy("gen-legacy-2");
    expect(empty).toMatchObject({ receipt_id: "gen-legacy-2", lane: null });
    expect(empty.label.prompt_readers.provider).toMatchObject({ id: null, access: "unknown" });
    expect(empty.label.payment.kind).toBe("unknown");
  });

  test("the endpoint: public by id like the receipt, 404 for an unknown id, and the receipt gains `privacy` without any change to what is signed", async () => {
    const r = await chat({ provider: { lane: "attested" } });
    const j = (await r.json()) as any;
    const id = j.id as string;
    // No credentials, wrong credentials: the same answer, as for the receipt itself.
    expect((await h.request(`/api/v1/receipts/${id}`)).status).toBe(200);
    expect((await h.request(`/api/v1/receipts/${id}/privacy`, { headers: { authorization: "Bearer not-a-key" } })).status).toBe(200);
    const missing = await h.request("/api/v1/receipts/gen-nope-nothing/privacy");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.type).toBe("not_found");

    const got = (await (await h.request(`/api/v1/receipts/${id}`)).json()) as any;
    expect(got.data.privacy).toEqual(await privacy(id));
    expect(got.data.privacy.receipt_id).toBe(id);
    // The signed payload is exactly what the chat call returned, carries no label, and still verifies.
    expect(got.data.payload).toEqual(j.receipt.payload);
    expect(got.data.payload).not.toHaveProperty("privacy");
    expect(got.data.sig).toBe(j.receipt.sig);
    const v = (await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: got.data.payload, sig: got.data.sig, key_id: got.data.key_id } })).json()) as any;
    expect(v.data.signature_valid).toBe(true);
    // The stored signature covers the payload alone.
    const [g] = await h.ctx.db.select().from(generations).where(eq(generations.id, id));
    expect(g.receipt).toEqual(j.receipt.payload);
    // The COSE form is untouched.
    const cose = await h.request(`/api/v1/receipts/${id}?format=cose`);
    expect(cose.status).toBe(200);
    expect(cose.headers.get("content-type")).toContain("application/cose");
    // The client helper reads it through the real route, and computes the same label from the receipt it holds.
    const fetched = await fetchPrivacyLabel("http://router.test", id, shim());
    expect(fetched).toEqual(got.data.privacy);
    expect(clientLabel(got.data, { teeKind: "tdx", unlinkableTransports: ["onion"], baseUrl: h.ctx.cfg.publicUrl })).toEqual(fetched);
  });

  test("the MCP chat tool result carries the summary", async () => {
    const res = await h.request("/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", ...auth }, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat", arguments: { model: GW_MODEL, prompt: "hi", lane: "attested" } } } });
    const s = ((await res.json()) as any).result.structuredContent;
    expect(s.lane).toBe("attested");
    expect(s.privacy.summary).toHaveLength(5);
    expect(s.privacy.summary[0]).toContain("attested enclave");
    expect(s.privacy.short).toStartWith("Read by: router + proven enclave");
    expect(s.privacy.verify_url).toBe(`${h.ctx.cfg.publicUrl}/verify?r=${s.receipt_id}`);
    expect(s.privacy).toEqual({ summary: (await privacy(s.receipt_id)).summary, short: (await privacy(s.receipt_id)).short, verify_url: (await privacy(s.receipt_id)).verify_url });
  });
});
