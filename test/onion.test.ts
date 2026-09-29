import { describe, expect, test } from "bun:test";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { matchesOnionSecret, ONION_HEADER, parseOnionAddress, parseOnionSecrets } from "../src/lib/onion.ts";

// Reaching the router over Tor: the published address, and rate limits for requests that carry no client address.

// Version 3 onion hostnames built from throwaway keys (SHA3-256 checksum computed independently of the code under test).
const ADDRESS = "a2w2k7bgvjopikpj6lakthr6jjbnv3gul7cmsvoxye4zvnbcplunvlyd.onion";
const OTHER = "4dxvnvxlma6z77uh45gcrobbbmhksobz4lve7nspd7bmm3uv4oizxwid.onion";
const SECRET = "onion-proxy-secret-for-tests-0123456789abcdef";
const ONION = { [ONION_HEADER]: SECRET };
const chat = { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 20 };
const PROVIDERS = [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.embed] }];
/** Every request reaches the router from the same peer, as they do from the onion proxy on a private network. */
const PROXY_PEER = { requestIP: () => ({ address: "10.20.30.40" }) };

const post = (h: Harness, path: string, headers: Record<string, string> = {}, json: unknown = chat) =>
  h.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(json) }, PROXY_PEER);
const statuses = async (n: number, f: () => Promise<Response>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await f()).status);
  return out;
};

describe("onion address and secret parsing", () => {
  test("accepts a version 3 address and lowercases it", () => {
    expect(parseOnionAddress(ADDRESS)).toBe(ADDRESS);
    expect(parseOnionAddress(`  ${OTHER.toUpperCase()} `)).toBe(OTHER);
  });

  test("refuses anything else: a scheme, a path, a version 2 name, a wrong length, a typo", () => {
    expect(() => parseOnionAddress(`http://${ADDRESS}`)).toThrow(/version 3 onion hostname/);
    expect(() => parseOnionAddress(`${ADDRESS}/api`)).toThrow(/version 3 onion hostname/);
    expect(() => parseOnionAddress("expyuzz4wqqyqhjn.onion")).toThrow(/version 3 onion hostname/);
    expect(() => parseOnionAddress(ADDRESS.replace(".onion", "a.onion"))).toThrow(/version 3 onion hostname/);
    expect(() => parseOnionAddress("example.com")).toThrow(/version 3 onion hostname/);
    // One character changed keeps the shape but breaks the checksum.
    const typo = (ADDRESS[5] === "a" ? "b" : "a");
    expect(() => parseOnionAddress(ADDRESS.slice(0, 5) + typo + ADDRESS.slice(6))).toThrow(/checksum/);
  });

  test("secrets: 32 or more header-safe characters, at most three, no repeats", () => {
    expect(parseOnionSecrets(undefined)).toEqual([]);
    expect(parseOnionSecrets("")).toEqual([]);
    expect(parseOnionSecrets(SECRET)).toEqual([SECRET]);
    expect(parseOnionSecrets(` ${SECRET} , ${SECRET}-next `)).toEqual([SECRET, `${SECRET}-next`]);
    expect(() => parseOnionSecrets("short")).toThrow(/32 to 200/);
    expect(() => parseOnionSecrets(`${SECRET} with spaces`)).toThrow(/32 to 200/);
    expect(() => parseOnionSecrets(`${SECRET}"`)).toThrow(/32 to 200/);
    expect(() => parseOnionSecrets(`${SECRET},${SECRET}`)).toThrow(/twice/);
    expect(() => parseOnionSecrets(["a", "b", "c", "d"].map((x) => x.repeat(32)).join(","))).toThrow(/at most three/);
  });

  test("a header matches only an exact secret, and any of those being rotated", () => {
    const rotating = [SECRET, `${SECRET}-next`];
    expect(matchesOnionSecret(rotating, SECRET)).toBe(true);
    expect(matchesOnionSecret(rotating, `${SECRET}-next`)).toBe(true);
    expect(matchesOnionSecret(rotating, `${SECRET}-nex`)).toBe(false);
    expect(matchesOnionSecret(rotating, "")).toBe(false);
    expect(matchesOnionSecret(rotating, null)).toBe(false);
    expect(matchesOnionSecret([], SECRET)).toBe(false);
  });
});

describe("configuration", () => {
  test("off by default", () => {
    const cfg = loadConfig({ ANYROUTE_ENV: "test" });
    expect(cfg.onion).toEqual({ address: null, secrets: [], poolMultiplier: 10 });
  });

  test("an address needs the secret the proxy sends, so its requests are not limited as one client", () => {
    expect(() => loadConfig({ ANYROUTE_ENV: "test", ONION_ADDRESS: ADDRESS })).toThrow(/ONION_ADDRESS requires ONION_PROXY_SECRET/);
    const cfg = loadConfig({ ANYROUTE_ENV: "test", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET });
    expect(cfg.onion).toEqual({ address: ADDRESS, secrets: [SECRET], poolMultiplier: 10 });
    // The secret alone is fine: requests are recognised, and no address is published.
    expect(loadConfig({ ANYROUTE_ENV: "test", ONION_PROXY_SECRET: SECRET }).onion.address).toBeNull();
  });

  test("invalid values are refused at start-up", () => {
    expect(() => loadConfig({ ANYROUTE_ENV: "test", ONION_ADDRESS: "example.com", ONION_PROXY_SECRET: SECRET })).toThrow(/ONION_ADDRESS/);
    expect(() => loadConfig({ ANYROUTE_ENV: "test", ONION_PROXY_SECRET: "too-short" })).toThrow(/ONION_PROXY_SECRET/);
    for (const bad of ["0", "1001", "2.5", "many"]) expect(() => loadConfig({ ANYROUTE_ENV: "test", ONION_POOL_MULTIPLIER: bad })).toThrow();
  });
});

describe("status and the Onion-Location header", () => {
  test("GET /api/v1/status publishes the address, never the secret", async () => {
    const h = await startRouter({ env: { ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      const res = await h.request("/api/v1/status");
      const text = await res.text();
      expect(JSON.parse(text).data.onion).toEqual({ address: ADDRESS, url: `http://${ADDRESS}` });
      expect(text).not.toContain(SECRET);
    } finally {
      await h.close();
    }
  });

  test("status says onion is null when none is configured", async () => {
    const h = await startRouter({ providers: PROVIDERS });
    try {
      expect((await (await h.request("/api/v1/status")).json()).data.onion).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("clearnet pages point Tor Browser at the onion twin; the onion twin does not point at itself", async () => {
    const h = await startRouter({ env: { ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    const plain = await startRouter({ providers: PROVIDERS });
    try {
      const page = await h.request("/");
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("onion-location")).toBe(`http://${ADDRESS}/`);
      expect((await h.request("/?ref=x")).headers.get("onion-location")).toBe(`http://${ADDRESS}/?ref=x`);
      expect((await h.request("/", { headers: ONION })).headers.get("onion-location")).toBeNull();
      // A forged header is an ordinary client, which still gets the pointer.
      expect((await h.request("/", { headers: { [ONION_HEADER]: "guess" } })).headers.get("onion-location")).toBe(`http://${ADDRESS}/`);
      expect((await h.request("/api/v1/status")).headers.get("onion-location")).toBeNull(); // JSON, not a page
      expect((await plain.request("/")).headers.get("onion-location")).toBeNull();
    } finally {
      await h.close();
      await plain.close();
    }
  });
});

describe("rate limits for requests that arrive over Tor", () => {
  test("without special handling every onion client would be one client; with it they get a shared pool of their own", async () => {
    const h = await startRouter({ env: { UNAUTH_RPM: "2", ONION_POOL_MULTIPLIER: "3", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      // Requests from the proxy's own address with no marker: the third is limited (this is the bucket a proxy would exhaust).
      expect(await statuses(3, () => post(h, "/api/v1/chat/completions"))).toEqual([402, 402, 429]);
      // Marked requests use a separate bucket, six times the size here (2 x 3), and the ordinary client's exhausted bucket does not affect them.
      expect(await statuses(7, () => post(h, "/api/v1/chat/completions", ONION))).toEqual([402, 402, 402, 402, 402, 402, 429]);
      // And they did not touch the ordinary bucket either way: it is still exhausted, not reset.
      expect((await post(h, "/api/v1/chat/completions")).status).toBe(429);
    } finally {
      await h.close();
    }
  });

  test("the client cannot choose its bucket: rotating X-Forwarded-For does not multiply the pool, a wrong secret earns no pool", async () => {
    const h = await startRouter({ env: { UNAUTH_RPM: "1", ONION_POOL_MULTIPLIER: "3", TRUST_PROXY: "true", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      let n = 0;
      const onion = () => post(h, "/api/v1/chat/completions", { ...ONION, "x-forwarded-for": `9.9.9.${++n}` });
      expect(await statuses(4, onion)).toEqual([402, 402, 402, 429]);
      // The header without the secret, or with a near miss, is an ordinary client: one request, then limited.
      for (const forged of ["guess", SECRET.slice(0, -1), `${SECRET}x`, ""]) {
        const from = () => post(h, "/api/v1/chat/completions", { [ONION_HEADER]: forged, "x-forwarded-for": `8.8.8.${forged.length}` });
        expect(await statuses(2, from)).toEqual([402, 429]);
      }
    } finally {
      await h.close();
    }
  });

  test("a call with an API key is limited per key, whether or not it came over Tor", async () => {
    const h = await startRouter({ env: { DEFAULT_RPM: "2", UNAUTH_RPM: "1", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      const a = await h.newKey();
      const b = await h.newKey();
      const viaOnion = (k: { auth: Record<string, string> }) => post(h, "/api/v1/chat/completions", { ...ONION, ...k.auth });
      expect(await statuses(3, () => viaOnion(a))).toEqual([402, 402, 429]); // a's own limit (2), not a pool
      expect(await statuses(2, () => viaOnion(b))).toEqual([402, 402]); // b is untouched by a
      // Neither used the pool for unkeyed calls (UNAUTH_RPM 1 x 10 here): it is still untouched.
      expect(await statuses(2, () => post(h, "/api/v1/chat/completions", ONION))).toEqual([402, 402]);
    } finally {
      await h.close();
    }
  });

  test("embeddings without a key use the same shared onion bucket", async () => {
    const h = await startRouter({ env: { UNAUTH_RPM: "1", ONION_POOL_MULTIPLIER: "2", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      const embed = (headers: Record<string, string>) => () => post(h, "/api/v1/embeddings", headers, { model: MODELS.embed.slug, input: "hello" });
      expect(await statuses(2, embed({}))).toEqual([402, 429]);
      expect(await statuses(3, embed(ONION))).toEqual([402, 402, 429]);
    } finally {
      await h.close();
    }
  });

  test("new keys: onion clients share a bounded pool; an ordinary address has its own smaller limit", async () => {
    const h = await startRouter({ env: { NEW_KEYS_PER_HOUR: "1", ONION_POOL_MULTIPLIER: "3", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      const create = (headers: Record<string, string>) => () => post(h, "/api/v1/keys", headers, { name: "k" });
      expect(await statuses(2, create({}))).toEqual([201, 429]);
      expect(await statuses(4, create(ONION))).toEqual([201, 201, 201, 429]);
    } finally {
      await h.close();
    }
  });

  test("blind-token calls: the redeem limit is shared across the onion pool, apart from the ordinary one", async () => {
    const h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", BLIND_REDEEM_RPM: "2", ONION_POOL_MULTIPLIER: "2", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      const bad = (headers: Record<string, string>) => () => post(h, "/api/v1/chat/completions", { authorization: "PrivateToken token=AAAA", ...headers });
      expect(await statuses(3, bad({}))).toEqual([401, 401, 429]);
      expect(await statuses(5, bad(ONION))).toEqual([401, 401, 401, 401, 429]);
    } finally {
      await h.close();
    }
  });

  test("wallet sign-in challenges and the paymaster are limited by the same bucket", async () => {
    const h = await startRouter({ env: { ONION_POOL_MULTIPLIER: "1", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      const challenge = (headers: Record<string, string>) => () => post(h, "/api/v1/auth/wallet/challenge", headers, { address: "0x00000000000000000000000000000000000000aa" });
      // 30 per minute for an address; onion clients share one bucket of the same size here (multiplier 1) that the ordinary one does not touch.
      expect((await statuses(30, challenge({}))).every((s) => s === 200)).toBe(true);
      expect((await challenge({})()).status).toBe(429);
      expect((await challenge(ONION)()).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  test("the gateway's direct limit is shared across the onion pool too", async () => {
    const h = await startRouter({ env: { ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true", OHTTP_DIRECT_RPM: "1", ONION_POOL_MULTIPLIER: "3", ONION_ADDRESS: ADDRESS, ONION_PROXY_SECRET: SECRET }, providers: PROVIDERS });
    try {
      const send = (headers: Record<string, string>) => () =>
        h.app.request("/api/v1/ohttp/gateway", { method: "POST", headers: { "content-type": "message/ohttp-req", ...headers }, body: new Uint8Array(4) }, PROXY_PEER);
      // Too short to be a request: 400 once past the limiter, 429 when limited.
      expect(await statuses(2, send({}))).toEqual([400, 429]);
      expect(await statuses(4, send(ONION))).toEqual([400, 400, 400, 429]);
    } finally {
      await h.close();
    }
  });
});
