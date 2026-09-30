import { describe, expect, test } from "bun:test";
import { fetchPrivacyLabel, privacyLabel, privacyPath, privacyShortLine, verifyReceipt } from "../src/index.js";
import { json, makeRouterKey, signReceipt, stubFetch } from "./helpers.js";

const KEY_HASH = "0x" + "ab".repeat(32);
const payload = {
  v: 1,
  id: "gen-client-1",
  router: "https://router.example",
  model: "acme/chat",
  provider: "gw",
  mode: "blind",
  payer: null,
  nullifier: "ef".repeat(32),
  disclosure: "attested",
  lane: "unlinkable",
  attestation: "0x" + "12".repeat(32),
  upstream_attestation: { kind: "aci/1", receipt_verified: true, attested: true, gpu_attested: true },
};

describe("the privacy label on the client", () => {
  test("is computed from a receipt the client has verified, and says what that receipt says", async () => {
    const key = makeRouterKey();
    const jwk = await key.ready;
    const receipt = await signReceipt(key.privateKey, jwk.kid, payload);
    const v = await verifyReceipt(receipt, { keys: { keys: [jwk] } });
    expect(v.valid).toBe(true);
    const label = privacyLabel(receipt, { teeKind: "tdx", unlinkableTransports: ["onion"] });
    expect(label).toMatchObject({ receipt_id: "gen-client-1", lane: "unlinkable", verify_url: "https://router.example/verify?r=gen-client-1" });
    expect(label.label.network).toMatchObject({ hidden: true, via: "tor" });
    expect(label.label.payment).toMatchObject({ kind: "blind_token", identifies: "spent_token" });
    expect(label.label.hardware).toMatchObject({ attested: true, tee: "Intel TDX", gpu_attested: true, verified_by: "gateway_receipt" });
    expect(label.summary).toHaveLength(5);
    expect(label.short).toBe("Read by: router + proven enclave · IP: hidden (Tor) · Paid: blind token, no account");
    expect(privacyShortLine(label, "telegram")).toBe("Read by: Telegram + router + proven enclave · IP: seen by Telegram, not AnyRoute · Paid: blind token, no account");
  });

  test("a key-paid public call is neither hidden nor attested", () => {
    const pub = privacyLabel({ payload: { ...payload, lane: "public", mode: "prepaid", payer: KEY_HASH, nullifier: undefined, disclosure: "vendor-forwarded", upstream_attestation: undefined } });
    expect(pub.label.hardware.attested).toBe(false);
    expect(pub.label.network.hidden).toBe(false);
    expect(pub.label.payment.kind).toBe("key_balance");
    expect(pub.label.prompt_readers.provider.access).toBe("provider");
  });

  test("the fetch helper asks the public endpoint and reads the router's label", async () => {
    const label = privacyLabel({ payload });
    const { fetch, calls } = stubFetch({ [privacyPath("gen-client-1")]: () => json({ data: label }) });
    expect(await fetchPrivacyLabel("https://router.example/", "gen-client-1", fetch)).toEqual(label);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://router.example/api/v1/receipts/gen-client-1/privacy");
    expect(new Headers(calls[0].init?.headers).has("authorization")).toBe(false);
    await expect(fetchPrivacyLabel("https://router.example", "gen-missing", fetch)).rejects.toThrow(/404/);
  });
});
