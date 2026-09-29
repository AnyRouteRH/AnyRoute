import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, concatBytes, evaluateAttestation, HPKE_MEDIA_TYPE, sealedPost, verifyProvider, type HpkeHook, type ProviderVerification } from "../src/index.js";
import { json, real, stubFetch } from "./helpers.js";

// A stand-in for a real HPKE implementation: it only needs to have the hook's shape. It "encrypts" with AES-GCM under
// a key derived from the recipient key, which is enough to show what the client does around the hook.
const fakeHook = (log: { recipient?: string } = {}): HpkeHook => ({
  async seal({ plaintext, recipientPublicKey }) {
    log.recipient = bytesToHex(recipientPublicKey);
    const key = await crypto.subtle.importKey("raw", (await crypto.subtle.digest("SHA-256", recipientPublicKey as unknown as BufferSource)) as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext as unknown as BufferSource));
    return {
      body: concatBytes(iv, ct),
      headers: { "x-fake-context": "1" },
      async open({ body }) {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: body.subarray(0, 12) as unknown as BufferSource }, key, body.subarray(12) as unknown as BufferSource));
      },
    };
  },
});

async function verified(hpkeKey?: string): Promise<ProviderVerification> {
  const boot = structuredClone(real.boot());
  const v = await evaluateAttestation({ providerId: "example-provider", router: real.router(), boot, certificate: real.certPem() }, { now: () => real.now });
  if (hpkeKey && v.bound) v.bound.hpkePubkey = hpkeKey;
  return v;
}

describe("HPKE hook", () => {
  test("seals to the attested key, sends the media type, and opens the reply", async () => {
    const log: { recipient?: string } = {};
    const seen: { headers: Headers; body: Uint8Array }[] = [];
    const v = await verified("ab".repeat(32));
    const { fetch } = stubFetch({
      "POST /v1/chat/completions": async ({ init }) => {
        const body = new Uint8Array(init!.body as Uint8Array);
        seen.push({ headers: new Headers(init!.headers as Record<string, string>), body });
        // The "server": derive the same key from the recipient key and answer sealed.
        const key = await crypto.subtle.importKey("raw", (await crypto.subtle.digest("SHA-256", Uint8Array.from(Buffer.from("ab".repeat(32), "hex")))) as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
        const plain = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: body.subarray(0, 12) }, key, body.subarray(12) as unknown as BufferSource)));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify({ echoed: plain.messages[0].content })) as unknown as BufferSource));
        return new Response(concatBytes(iv, ct) as unknown as BodyInit, { headers: { "content-type": HPKE_MEDIA_TYPE } });
      },
    });
    const out = await sealedPost({ hook: fakeHook(log), url: "https://provider.test/v1/chat/completions", verification: v, json: { messages: [{ content: "secret prompt" }] }, headers: { authorization: "Bearer k" }, fetch });
    expect(out.json).toEqual({ echoed: "secret prompt" });
    expect(log.recipient).toBe("ab".repeat(32));
    expect(seen[0].headers.get("content-type")).toBe("application/anyroute-hpke");
    expect(seen[0].headers.get("x-fake-context")).toBe("1");
    expect(seen[0].headers.get("authorization")).toBe("Bearer k");
    expect(new TextDecoder().decode(seen[0].body).includes("secret prompt")).toBe(false); // nothing readable on the wire
  });

  test("refuses to encrypt to a provider that did not verify", async () => {
    const v = await verified("ab".repeat(32));
    const bad = { ...v, ok: false };
    const { fetch, calls } = stubFetch({});
    await expect(sealedPost({ hook: fakeHook(), url: "https://provider.test/x", verification: bad, json: {}, fetch })).rejects.toThrow(/did not verify/);
    expect(calls).toHaveLength(0);
  });

  test("refuses when the quote does not commit to an HPKE key, unless the caller says the key is unbound", async () => {
    const v = await verified();
    const { fetch, calls } = stubFetch({ "POST /x": () => json({ error: "nope" }, 400) });
    await expect(sealedPost({ hook: fakeHook(), url: "https://provider.test/x", verification: v, json: {}, fetch })).rejects.toThrow(/does not commit to an HPKE public key/);
    expect(calls).toHaveLength(0);
    const log: { recipient?: string } = {};
    const out = await sealedPost({ hook: fakeHook(log), url: "https://provider.test/x", verification: v, json: {}, fetch, unboundRecipientKey: "cd".repeat(32) });
    expect(log.recipient).toBe("cd".repeat(32));
    expect(out.status).toBe(400); // the server's plain-JSON error is returned as is
  });
});

// The sidecar's own encrypted transport (sidecar/src/hpke.ts, with a reference client). This runs against it when the
// sidecar's dependencies are installed (`cd sidecar && bun install`), and is skipped otherwise.
const sidecar = new URL("../../../sidecar/", import.meta.url).pathname;
const sidecarReady = (() => {
  try {
    if (!existsSync(join(sidecar, "src/hpke.ts"))) return false;
    Bun.resolveSync("@hpke/core", join(sidecar, "src"));
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!sidecarReady)("interop with the sidecar's encrypted transport", () => {
  const load = async () => ({
    helpers: (await import(join(sidecar, "test/helpers.ts"))),
    hpke: (await import(join(sidecar, "src/hpke.ts"))),
    client: (await import(join(sidecar, "src/hpke-client.ts"))),
  });

  test("the media type is the one the sidecar serves", async () => {
    const { hpke } = await load();
    expect(HPKE_MEDIA_TYPE).toBe(hpke.HPKE_CONTENT_TYPE);
  });

  test("a request sealed to the attested HPKE key reaches the model server in the clear, and the reply and receipt verify", async () => {
    const { helpers, client } = await load();
    try {
      const h = await helpers.harness({ provider: helpers.dstackProvider({ composeHash: `sha256:${"ce".repeat(32)}` }), raw: { attestation: { provider: "dstack" }, image_digest: `sha256:${"1e".repeat(32)}` }, env: {}, hpke: true });
      const doc = (await (await h.call("/attest", { key: null })).json()) as any;
      expect(doc.bindings.hpke_pubkey).toBe(h.rt.hpke!.publicKeyHex);

      // Verify the provider the way a caller would; the HPKE key is only usable if the quote commits to it.
      const router = { provider: "sidecar-test", status: "attested", tee: "tdx", attested_at: new Date().toISOString(), attestation_hash: null, verifiers: ["dcap"], measurement: null, checks: { quote_verified: true, digests_bound_to_quote: true, transparency_log_entry: false, transparency_log_checkpoint_signature: false, registered_on_chain: false }, not_checked: [] };
      const v = await verifyProvider({
        routerUrl: "https://router.test",
        providerId: "sidecar-test",
        attestUrl: "https://sidecar.test/attest",
        fetch: (async () => json({ data: router })) as never,
        attestFetcher: async (url) => ({ json: await (await h.call(new URL(url).pathname + new URL(url).search, { key: null })).json() }),
        certificate: h.rt.tls!.certPem,
      });
      expect(v.failures).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.bound?.hpkePubkey).toBe(h.rt.hpke!.publicKeyHex);

      // The hook is the sidecar's reference client; the SDK supplies the policy around it.
      const hook: HpkeHook = {
        async seal({ plaintext, recipientPublicKey, url }) {
          const sealed = await client.sealRequest(bytesToHex(recipientPublicKey), new URL(url).pathname, plaintext);
          return { body: sealed.body, open: async ({ body }) => client.openResponse(sealed.opener, body) };
        },
      };
      const request = { model: "ok", messages: [{ role: "user", content: "a private question" }] };
      const seenBefore = h.upstream.seen.filter((x: { method: string }) => x.method === "POST").length;
      const out = await sealedPost({
        hook,
        url: "https://sidecar.test/v1/chat/completions",
        verification: v,
        json: request,
        headers: { authorization: `Bearer ${helpers.API_KEY}` },
        fetch: (async (url: string, init: RequestInit) => h.call(new URL(url).pathname, { ...init, key: null })) as never,
      });
      expect(out.status).toBe(200);
      expect((out.json as any).choices[0].message.content).toBe("Hello");
      const seen = h.upstream.seen.filter((x: { method: string }) => x.method === "POST");
      expect(seen).toHaveLength(seenBefore + 1);
      expect(seen.at(-1)!.body).toBe(JSON.stringify(request));

      // If the quote commits to no HPKE key, nothing is sealed or sent.
      const unbound = { ...v, bound: { ...v.bound!, hpkePubkey: null } };
      await expect(sealedPost({ hook, url: "https://sidecar.test/v1/chat/completions", verification: unbound, json: request, fetch: (async () => new Response("no")) as never })).rejects.toThrow(/does not commit to an HPKE public key/);
    } finally {
      (await load()).helpers.cleanup();
    }
  });
});
