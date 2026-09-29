import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, concatBytes, evaluateAttestation, HPKE_MEDIA_TYPE, sealedPost, type HpkeHook, type ProviderVerification } from "../src/index.js";
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

// The sidecar's HPKE support is being written separately. This only runs once its source exists in the repository.
const sidecarSrc = new URL("../../../sidecar/src", import.meta.url).pathname;
const hpkeSources = existsSync(sidecarSrc)
  ? (readdirSync(sidecarSrc, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => join(sidecarSrc, f)).filter((f) => readFileSync(f, "utf8").includes("anyroute-hpke"))
  : [];

describe.skipIf(hpkeSources.length === 0)("integration with the sidecar's HPKE code", () => {
  test("the sidecar and the client name the same media type", () => {
    for (const f of hpkeSources) expect(readFileSync(f, "utf8")).toContain(HPKE_MEDIA_TYPE);
  });
});
