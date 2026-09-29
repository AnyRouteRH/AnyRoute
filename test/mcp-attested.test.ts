import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { balanceOf } from "../src/ledger/ledger.ts";
import { keys as keysTable } from "../src/db/schema.ts";
import { CLAIMS_OK } from "./aci-fixtures.ts";
import { GW_MODEL, PLAIN, startGatewayRouter } from "./aci-mock-gateway.ts";

// The MCP server's attested surface: chat with a lane, list_attested_models, verify_provider and a server-level
// default set on the /mcp URL or in a header. Every call goes through JSON-RPC to /mcp against a router that has one
// public provider and one attested aci/1 gateway.

let fx: Awaited<ReturnType<typeof startGatewayRouter>>;
let auth: Record<string, string>;
let keyHash: string;

beforeAll(async () => {
  fx = await startGatewayRouter();
  const k = await fx.h.fundedKey(20n);
  auth = k.auth;
  keyHash = k.hash;
});
afterAll(async () => fx.close());
beforeEach(async () => {
  expect(await fx.reset()).toMatchObject({ provider: "gw", ok: true });
});

const rpc = (body: unknown, headers: Record<string, string> = {}, path = "/mcp") => fx.h.request(path, { method: "POST", headers: { accept: "application/json, text/event-stream", ...headers }, json: body });
const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = auth, path = "/mcp") => {
  const res = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, headers, path);
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean }; error?: { code: number; message: string } };
};
const balance = async () => {
  const [k] = await fx.h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, keyHash));
  return (await balanceOf(fx.h.ctx.db, k.accountId)).balance;
};

describe("tool definitions", () => {
  test("chat takes lane and disclosure; the two new tools need no key and are read-only", async () => {
    const j = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    const tools = Object.fromEntries((j.result.tools as any[]).map((t) => [t.name, t]));
    expect(Object.keys(tools).sort()).toEqual(["chat", "get_receipt", "list_attested_models", "list_models", "verify_provider", "verify_receipt"]);
    expect(tools.chat.inputSchema.properties.lane.enum).toEqual(["public", "attested"]);
    expect(tools.chat.inputSchema.properties.disclosure.enum).toEqual(["none", "policy", "any"]);
    expect(tools.chat.inputSchema.required).toEqual(["model"]);
    for (const n of ["list_attested_models", "verify_provider"]) expect(tools[n].annotations.readOnlyHint).toBe(true);
    expect(tools.verify_provider.inputSchema.required).toEqual(["provider_id"]);
  });

  test("initialize announces a restricted connection only when the URL or a header restricts it", async () => {
    const init = async (path: string, headers: Record<string, string> = {}) =>
      ((await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, headers, path)).json()) as any).result.instructions as string;
    expect(await init("/mcp")).not.toContain("restricted");
    expect(await init("/mcp?lane=attested")).toContain("This connection is restricted");
    expect(await init("/mcp", { "x-anyroute-lane": "attested" })).toContain("This connection is restricted");
    expect(await init("/mcp")).toContain("list_attested_models");
    // A malformed default does not break the handshake; the first chat call refuses it.
    expect(await init("/mcp?lane=fast")).not.toContain("restricted");
  });
});

describe("list_attested_models", () => {
  test("lists only models with an attested endpoint, with prices, and says what gpu_attested means; no key needed", async () => {
    const all = (await call("list_models", {}, {})).result!.structuredContent;
    expect(all.models.map((m: any) => m.id)).toEqual(expect.arrayContaining([GW_MODEL, PLAIN.slug]));
    const j = (await call("list_attested_models", {}, {})).result!;
    expect(j.isError).toBeUndefined();
    const s = j.structuredContent;
    expect(s).toMatchObject({ lane: "attested", total: 1, returned: 1 });
    expect(s.models).toEqual([{ id: GW_MODEL, name: "Attested gateway chat", context_length: 32768, price_per_1m_input_usd: 1, price_per_1m_output_usd: 2, attested_endpoints: 1, gpu_attested: null }]);
    expect(s.gpu_attested_means).toContain("null: no receipt recorded yet");
    expect(s.attested_means).toContain("not what it does with data");
    expect(JSON.parse(j.content[0]!.text).lane).toBe("attested");
    // Filtering and limiting work like list_models.
    expect((await call("list_attested_models", { query: "nomatch" }, {})).result!.structuredContent.models).toEqual([]);
    expect((await call("list_attested_models", { query: "ATTESTED gateway", limit: 1 }, {})).result!.structuredContent.returned).toBe(1);
  });

  test("gpu_attested follows the latest verified receipt, and the model leaves the list when its attestation lapses", async () => {
    const listed = async () => ((await call("list_attested_models", {}, {})).result!.structuredContent.models as any[]).find((m) => m.id === GW_MODEL);
    expect((await call("chat", { model: GW_MODEL, prompt: "warm up", lane: "attested" })).result!.isError).toBeUndefined();
    await fx.h.ctx.catalog.refresh();
    expect(await listed()).toMatchObject({ gpu_attested: true });
    fx.state.claims = { ...CLAIMS_OK, gpu_attested: { status: "unknown" } };
    await call("chat", { model: GW_MODEL, prompt: "no gpu this time", lane: "attested" });
    await fx.h.ctx.catalog.refresh();
    expect(await listed()).toMatchObject({ gpu_attested: false });
    await fx.makeStale();
    expect((await call("list_attested_models", {}, {})).result!.structuredContent).toMatchObject({ total: 0, models: [] });
  });
});

describe("verify_provider", () => {
  test("an attested provider: status, TEE, verifiers, TLS pin, transparency log and what is not checked, in plain terms", async () => {
    const s = (await call("verify_provider", { provider_id: "gw" }, {})).result!.structuredContent;
    expect(s).toMatchObject({
      provider: "gw",
      status: "attested",
      tee: "tdx",
      verifiers: ["phala"],
      tls_pin: { pinned: false },
      transparency_log: { entry_found: false, inclusion_verified: false },
      registered_on_chain: false,
      gateway: { protocol: "aci/1" },
    });
    expect(s.attested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.summary).toContain("The router verified this provider's TDX attestation itself (accepted by phala)");
    expect(s.summary).toContain("No TLS key is pinned for it.");
    expect(s.summary).toContain("not what it does with a prompt");
    expect(s.not_checked.length).toBeGreaterThan(2);
    expect(s.not_checked.some((n: string) => n.includes("prompts stay inside the enclave"))).toBe(true);
    expect(s.verify_page).toBe(`${fx.h.ctx.cfg.publicUrl}/verify?p=gw`);
    // The tool restates the router's own record.
    const rest = ((await (await fx.h.request("/api/v1/attestation/gw")).json()) as any).data;
    expect(s.status).toBe(rest.status);
    expect(s.not_checked).toEqual(rest.not_checked);
  });

  test("a lapsed attestation is unverified, and the summary says the attested lane will not use it", async () => {
    await fx.makeStale();
    const s = (await call("verify_provider", { provider_id: "gw" }, {})).result!.structuredContent;
    expect(s).toMatchObject({ status: "unverified", reason: "attestation_stale", verifiers: [] });
    expect(s.summary).toContain("older than it accepts");
    expect(s.summary).toContain("will not send an attested-lane request to it");
    expect(s.summary).not.toContain("verified this provider's");
  });

  test("a provider that never attested is unverified; an unknown one is a 404 tool error; a bad id is a parameter error", async () => {
    const vendor = (await call("verify_provider", { provider_id: "vendor" }, {})).result!.structuredContent;
    expect(vendor).toMatchObject({ provider: "vendor", status: "unverified", reason: "no_attestation", tee: null, tls_pin: { pinned: false } });
    expect(vendor.summary).toContain("no attestation on record");
    const missing = (await call("verify_provider", { provider_id: "nobody" }, {})).result!;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error).toMatchObject({ code: 404, type: "not_found" });
    for (const bad of ["../models", "", "a b", "x".repeat(200), 5]) expect((await call("verify_provider", { provider_id: bad }, {})).error?.code).toBe(-32602);
    expect((await call("verify_provider", {}, {})).error?.code).toBe(-32602);
  });
});

describe("chat on the attested lane", () => {
  test("the result reports the lane, the served class and the receipt's upstream attestation; the gateway is asked for attested, zero-retention serving", async () => {
    const before = await balance();
    const r = (await call("chat", { model: GW_MODEL, prompt: "hello, privately", lane: "attested", max_tokens: 16 })).result!;
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent;
    expect(s.text).toBe("hello from the gateway");
    expect(s).toMatchObject({ lane: "attested", disclosure: "attested", provider: "Gateway", model: GW_MODEL });
    expect(s.upstream_attestation).toMatchObject({ attested: true, gpu_attested: true, receipt_verified: true, kind: "aci/1" });
    expect(s.upstream_attestation.reason).toBeUndefined();
    expect(s.attestation_simulated).toBeUndefined();
    expect(r.content[0]).toEqual({ type: "text", text: "hello from the gateway" });
    expect(JSON.parse(r.content[1]!.text).upstream_attestation.attested).toBe(true);
    expect(fx.state.requests.at(-1)!.body.provider).toEqual({ aci_verified: true, zdr: true });
    // The signed receipt agrees with what the tool reported.
    const receipt = ((await (await fx.h.request(`/api/v1/receipts/${s.receipt_id}`)).json()) as any).data;
    expect(receipt.payload).toMatchObject({ lane: "attested", disclosure: "attested", upstream_attestation: { attested: true, gpu_attested: true } });
    expect(await balance()).toBeLessThan(before);
  });

  test("gpu_attested is false when the receipt does not assert GPU attestation", async () => {
    fx.state.claims = { ...CLAIMS_OK, gpu_attested: { status: "unknown" } };
    const s = (await call("chat", { model: GW_MODEL, prompt: "hi", lane: "attested" })).result!.structuredContent;
    expect(s.upstream_attestation).toMatchObject({ attested: true, gpu_attested: false });
  });

  test("disclosure none is the same test as the attested lane", async () => {
    const s = (await call("chat", { model: GW_MODEL, prompt: "hi", disclosure: "none" })).result!.structuredContent;
    expect(s).toMatchObject({ lane: "public", disclosure: "attested", upstream_attestation: { attested: true } });
    const refused = (await call("chat", { model: PLAIN.slug, prompt: "hi", disclosure: "none" })).result!;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error.type).toBe("disclosure_unavailable");
  });

  test("a model with no attested provider is refused: nothing is sent, nothing is charged, and the error says what to do", async () => {
    const before = await balance();
    const sent = fx.state.requests.length;
    const r = (await call("chat", { model: PLAIN.slug, prompt: "keep this private", lane: "attested" })).result!;
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: 503, type: "no_attested_endpoint" });
    expect(r.structuredContent.error.message).toContain("Nothing was sent to any provider and nothing was charged");
    expect(r.structuredContent.error.hint).toContain("list_attested_models");
    expect(r.content[0]!.text).toContain("list_attested_models");
    expect(await balance()).toBe(before);
    expect(fx.state.requests.length).toBe(sent);
  });

  test("a lapsed attestation refuses the call rather than falling back to a public provider", async () => {
    await fx.makeStale();
    const before = await balance();
    const r = (await call("chat", { model: GW_MODEL, prompt: "hi", lane: "attested" })).result!;
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.type).toBe("no_attested_endpoint");
    expect(await balance()).toBe(before);
  });

  test("an answer whose receipt does not show an attested upstream is withheld, and the error carries the billed receipt id", async () => {
    fx.state.upstream = "routed";
    const before = await balance();
    const r = (await call("chat", { model: GW_MODEL, prompt: "hi", lane: "attested" })).result!;
    expect(r.isError).toBe(true);
    expect(r.content.map((c) => c.text).join(" ")).not.toContain("hello from the gateway");
    const e = r.structuredContent.error;
    expect(e).toMatchObject({ code: 502, type: "upstream_not_attested" });
    expect(e.receipt_id).toStartWith("gen-");
    expect(e.hint).toContain("billed");
    expect(await balance()).toBeLessThan(before); // the upstream had already generated it
    const receipt = ((await (await fx.h.request(`/api/v1/receipts/${e.receipt_id}`)).json()) as any).data;
    expect(receipt.payload.upstream_attestation.attested).toBe(false);
  });

  test("a public call to the same provider is unchanged: no lane needed, and a routed answer is reported as not attested", async () => {
    fx.state.upstream = "routed";
    const s = (await call("chat", { model: GW_MODEL, prompt: "hi" })).result!.structuredContent;
    expect(s).toMatchObject({ lane: "public", text: "hello from the gateway", upstream_attestation: { attested: false, gpu_attested: false } });
    expect(s.upstream_attestation.reason).toContain("the upstream was not verified");
  });

  test("a public provider's result has a lane and a disclosure class but no upstream_attestation", async () => {
    const s = (await call("chat", { model: PLAIN.slug, prompt: "hi" })).result!.structuredContent;
    expect(s).toMatchObject({ lane: "public", disclosure: "vendor-forwarded", provider: "Vendor" });
    expect(s).not.toHaveProperty("upstream_attestation");
  });

  test("bad lane or disclosure values are parameter errors", async () => {
    for (const bad of [{ lane: "unlinkable" }, { lane: "fast" }, { disclosure: "sometimes" }]) expect((await call("chat", { model: GW_MODEL, prompt: "hi", ...bad })).error?.code).toBe(-32602);
  });
});

describe("a server-level default on the /mcp URL or in a header", () => {
  test("?lane=attested makes every chat call attested; a call cannot relax it", async () => {
    const url = "/mcp?lane=attested";
    const ok = (await call("chat", { model: GW_MODEL, prompt: "hi" }, auth, url)).result!.structuredContent;
    expect(ok).toMatchObject({ lane: "attested", disclosure: "attested", upstream_attestation: { attested: true } });
    const relaxed = (await call("chat", { model: GW_MODEL, prompt: "hi", lane: "public", disclosure: "any" }, auth, url)).result!.structuredContent;
    expect(relaxed.lane).toBe("attested");
    // A model with no attested provider is refused with the default alone, nothing sent or charged.
    const before = await balance();
    const refused = (await call("chat", { model: PLAIN.slug, prompt: "hi" }, auth, url)).result!;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error.type).toBe("no_attested_endpoint");
    expect(await balance()).toBe(before);
    // The same call on the plain URL still reaches the public provider.
    expect((await call("chat", { model: PLAIN.slug, prompt: "hi" })).result!.structuredContent.provider).toBe("Vendor");
  });

  test("the X-Anyroute-Lane and X-Anyroute-Disclosure-Max headers do the same, and the strictest setting wins", async () => {
    const lane = (await call("chat", { model: PLAIN.slug, prompt: "hi" }, { ...auth, "x-anyroute-lane": "attested" })).result!;
    expect(lane.structuredContent.error.type).toBe("no_attested_endpoint");
    const ceiling = (await call("chat", { model: PLAIN.slug, prompt: "hi" }, { ...auth, "x-anyroute-disclosure-max": "none" })).result!;
    expect(ceiling.structuredContent.error.type).toBe("disclosure_unavailable");
    const mixed = (await call("chat", { model: GW_MODEL, prompt: "hi" }, { ...auth, "x-anyroute-lane": "public" }, "/mcp?lane=attested")).result!.structuredContent;
    expect(mixed.lane).toBe("attested");
    const both = (await call("chat", { model: GW_MODEL, prompt: "hi" }, auth, "/mcp?lane=public&lane=attested")).result!.structuredContent;
    expect(both.lane).toBe("attested");
    const policy = (await call("chat", { model: GW_MODEL, prompt: "hi" }, auth, "/mcp?disclosure=policy")).result!.structuredContent;
    expect(policy).toMatchObject({ lane: "public", disclosure: "attested" });
  });

  test("an unrecognised default fails closed: the call is refused, nothing is sent, and it is never read as public", async () => {
    const before = await balance();
    const sent = fx.state.requests.length;
    for (const [path, headers] of [
      ["/mcp?lane=fast", auth],
      ["/mcp?lane=unlinkable", auth],
      ["/mcp?disclosure=sometimes", auth],
      ["/mcp", { ...auth, "x-anyroute-lane": "atested" }],
      ["/mcp?lane=attested&lane=fast", auth],
    ] as const) {
      const r = (await call("chat", { model: GW_MODEL, prompt: "hi" }, { ...headers }, path)).result!;
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toMatchObject({ code: 400, type: "invalid_request" });
      expect(r.structuredContent.error.message).toContain("No prompt was sent");
    }
    expect((await call("chat", { model: GW_MODEL, prompt: "hi" }, auth, "/mcp?lane=unlinkable")).result!.structuredContent.error.message).toContain("relay and a blind token");
    expect(await balance()).toBe(before);
    expect(fx.state.requests.length).toBe(sent);
    // The read-only tools do not depend on it.
    expect((await call("list_models", {}, {}, "/mcp?lane=fast")).result!.isError).toBeUndefined();
  });

  test("an empty ?lane= is no setting", async () => {
    expect((await call("chat", { model: PLAIN.slug, prompt: "hi" }, auth, "/mcp?lane=&disclosure=")).result!.structuredContent).toMatchObject({ lane: "public", provider: "Vendor" });
  });
});
