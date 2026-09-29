import { describe, expect, test } from "bun:test";
import { canonicalBytes, fetchReceiptKeys, hexToBytes, keccak256, parseKeySet, receiptLeaf, verifyMerkleProof, verifyReceipt, verifySidecarReceipt, type BoundIdentity, type ReceiptEnvelope } from "../src/index.js";
import { evaluateAttestation } from "../src/index.js";
import { json, makeRouterKey, real, signReceipt, stubFetch } from "./helpers.js";

const ok = (v: { checks: { id: string; status: string }[] }, id: string) => v.checks.find((c) => c.id === id)?.status;

describe("a real receipt from a TDX deployment", () => {
  const boundKey = () => real.boot().bindings.receipt_pubkey as string;

  test("verifies under the receipt key the quote commits to, and its leaf recomputes", async () => {
    const v = await verifyReceipt(real.receipt(), { publicKeyHex: boundKey() });
    expect(v.valid).toBe(true);
    expect(ok(v, "signature")).toBe("pass");
    expect(ok(v, "key")).toBe("pass");
    expect(ok(v, "leaf")).toBe("pass");
    // No anchor proof came with it, and the report says so instead of implying inclusion.
    expect(v.anchor).toBe("no_proof");
    expect(ok(v, "anchor_proof")).toBe("not_checked");
    expect(v.notChecked.join(" ")).toMatch(/on chain/);
  });

  test("fails when any signed field is changed", async () => {
    for (const change of [{ status: 500 }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, { model_digest: "sha256:" + "0".repeat(64) }, { extra: true }]) {
      const r = real.receipt();
      const v = await verifyReceipt({ ...r, payload: { ...r.payload, ...change } }, { publicKeyHex: boundKey() });
      expect(v.valid).toBe(false);
      expect(ok(v, "signature")).toBe("fail");
    }
  });

  test("fails under a different key, a different key id or a broken signature", async () => {
    const other = makeRouterKey();
    expect((await verifyReceipt(real.receipt(), { publicKeyHex: Buffer.from(other.raw).toString("hex") })).valid).toBe(false);
    expect((await verifyReceipt({ ...real.receipt(), key_id: "0000000000000000" }, { publicKeyHex: boundKey() })).valid).toBe(false);
    const bad = Buffer.from(real.receipt().sig, "base64");
    bad[3] ^= 1;
    expect((await verifyReceipt({ ...real.receipt(), sig: bad.toString("base64") }, { publicKeyHex: boundKey() })).valid).toBe(false);
    expect((await verifyReceipt({ ...real.receipt(), leaf: "0x" + "11".repeat(32) }, { publicKeyHex: boundKey() })).valid).toBe(false);
  });

  test("verifySidecarReceipt also ties the receipt to the verified attestation", async () => {
    const result = await evaluateAttestation({ providerId: "example-provider", router: real.router(), boot: real.boot(), certificate: real.certPem() }, { now: () => real.now });
    const bound = result.bound as BoundIdentity;
    const v = await verifySidecarReceipt(real.receipt(), bound);
    expect(v.valid).toBe(true);
    expect(ok(v, "sidecar.attestation_ref")).toBe("pass");
    expect(ok(v, "sidecar.model_digest")).toBe("pass");
    // Same signature, but the attestation the client verified is a different one: refuse.
    const v2 = await verifySidecarReceipt(real.receipt(), { ...bound, attestationRef: "ab".repeat(32) });
    expect(v2.valid).toBe(false);
    expect(ok(v2, "sidecar.attestation_ref")).toBe("fail");
    const v3 = await verifySidecarReceipt(real.receipt(), { ...bound, modelDigest: "sha256:" + "ab".repeat(32) });
    expect(v3.valid).toBe(false);
  });
});

describe("router receipts and the published key set", () => {
  const payload = { v: 1, id: "gen-1", issued: "2026-09-15T10:00:00.000Z", model: "m", provider: "p", tokens: { prompt: 3, completion: 4 }, cost: "0.00001" };

  test("verifies against the JWKS the router publishes, and only that key", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, payload);
    const v = await verifyReceipt(r, { keys: { keys: [jwk] } });
    expect(v.valid).toBe(true);
    expect(ok(v, "key_window")).toBe("pass");
    // Unknown key id, or a key set that does not contain it.
    expect((await verifyReceipt(r, { keys: { keys: [] } })).valid).toBe(false);
    const other = await makeRouterKey().ready;
    expect((await verifyReceipt(r, { keys: { keys: [other] } })).valid).toBe(false);
  });

  test("a receipt that records the provider's attestation (attested council, attested dual verification) verifies, and the record is signed", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const ref = { provider: "p", tee: "tdx", report_hash: "aa".repeat(32), attested_at: "2026-09-15T09:59:00.000Z", tls_pin: { spki_sha256: "bb".repeat(32), attestation_ref: "cc".repeat(32) } };
    const withRef = { ...payload, attestation: ref.report_hash, attestation_ref: ref, council: { role: "judge", attested: true, attestation_refs: [{ role: "judge", receipt_id: "gen-1", ...ref }] } };
    const r = await signReceipt(k.privateKey, jwk.kid, withRef);
    expect((await verifyReceipt(r, { keys: { keys: [jwk] } })).valid).toBe(true);
    // Receipts made before the field existed verify the same way.
    expect((await verifyReceipt(await signReceipt(k.privateKey, jwk.kid, payload), { keys: { keys: [jwk] } })).valid).toBe(true);
    // Changing the reference, or the council's list of them, breaks the signature.
    const forgedOwn = { ...r, payload: { ...withRef, attestation_ref: { ...ref, report_hash: "00".repeat(32) } } };
    const forgedList = { ...r, payload: { ...withRef, council: { ...withRef.council, attestation_refs: [] } } };
    for (const forged of [forgedOwn, forgedList]) {
      const v = await verifyReceipt(forged, { keys: { keys: [jwk] } });
      expect(v.valid).toBe(false);
      expect(ok(v, "signature")).toBe("fail");
    }
  });

  test("a key entry whose id does not match its bytes is rejected", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, payload);
    const liar = { ...jwk, x: (await makeRouterKey().ready).x };
    const v = await verifyReceipt(r, { keys: { keys: [liar] } });
    expect(v.valid).toBe(false);
    expect(ok(v, "key")).toBe("fail");
  });

  test("a receipt dated outside its key's window is flagged", async () => {
    const k = makeRouterKey("2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    const jwk = await k.ready;
    const late = await signReceipt(k.privateKey, jwk.kid, { ...payload, issued: "2026-09-20T00:00:00.000Z" });
    const v = await verifyReceipt(late, { keys: [jwk] });
    expect(v.valid).toBe(false);
    expect(ok(v, "key_window")).toBe("fail");
    const inside = await signReceipt(k.privateKey, jwk.kid, { ...payload, issued: "2026-09-05T00:00:00.000Z" });
    expect((await verifyReceipt(inside, { keys: [jwk] })).valid).toBe(true);
  });

  test("malformed input is a failed verification, not an exception", async () => {
    for (const bad of [null, {}, { payload: {}, sig: "", key_id: "" }, { payload: 5, sig: "x", key_id: "y" }] as unknown as ReceiptEnvelope[]) {
      const v = await verifyReceipt(bad, { keys: [] });
      expect(v.valid).toBe(false);
    }
  });

  test("a runtime without Ed25519 reports not_checked and never valid", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, payload);
    const { UnsupportedCrypto } = await import("../src/index.js");
    const v = await verifyReceipt(r, {
      keys: [jwk],
      ed25519: async () => {
        throw new UnsupportedCrypto("no Ed25519 here");
      },
    });
    expect(ok(v, "signature")).toBe("not_checked");
    expect(v.valid).toBe(false);
  });

  test("fetchReceiptKeys reads the well-known path and validates the shape", async () => {
    const jwk = await makeRouterKey().ready;
    const { fetch, calls } = stubFetch({ "/.well-known/anyroute-receipt-keys.json": () => json({ keys: [jwk] }) });
    expect((await fetchReceiptKeys("https://router.test/", fetch)).keys[0].kid).toBe(jwk.kid);
    expect(calls[0].url).toBe("https://router.test/.well-known/anyroute-receipt-keys.json");
    expect(() => parseKeySet({ nope: 1 })).toThrow();
    expect(() => parseKeySet({ keys: [{ kid: "a" }] })).toThrow();
    const failing = stubFetch({});
    await expect(fetchReceiptKeys("https://router.test", failing.fetch)).rejects.toThrow(/404/);
  });
});

describe("anchor inclusion", () => {
  const pair = (a: Uint8Array, b: Uint8Array) => {
    const cmp = Buffer.compare(a, b) < 0;
    return keccak256(Buffer.concat(cmp ? [a, b] : [b, a]));
  };
  const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

  test("verifies sorted-pair proofs and rejects wrong roots, leaves and proofs", () => {
    const leaves = [1, 2, 3, 4].map((n) => keccak256(new Uint8Array([n])));
    const l01 = pair(leaves[0], leaves[1]);
    const l23 = pair(leaves[2], leaves[3]);
    const root = pair(l01, l23);
    expect(verifyMerkleProof(hex(leaves[2]), [hex(leaves[3]), hex(l01)], hex(root))).toBe(true);
    expect(verifyMerkleProof(hex(leaves[2]), [hex(leaves[3]), hex(l23)], hex(root))).toBe(false);
    expect(verifyMerkleProof(hex(leaves[1]), [hex(leaves[3]), hex(l01)], hex(root))).toBe(false);
    expect(verifyMerkleProof(hex(leaves[2]), [], hex(leaves[2]))).toBe(true);
    expect(verifyMerkleProof("nothex", [], hex(root))).toBe(false);
  });

  test("a receipt with a proof reports proof_valid; a tampered proof fails the receipt", async () => {
    const k = makeRouterKey();
    const jwk = await k.ready;
    const r = await signReceipt(k.privateKey, jwk.kid, { v: 1, id: "g", issued: "2026-09-15T00:00:00.000Z" });
    const sibling = keccak256(new Uint8Array([9]));
    const leaf = hexToBytes(r.leaf!);
    const root = pair(leaf, sibling);
    const anchored = { ...r, anchor: { root: hex(root), proof: [hex(sibling)], index: 7, leaf_index: 0 } };
    const v = await verifyReceipt(anchored, { keys: [jwk] });
    expect(v.anchor).toBe("proof_valid");
    expect(v.valid).toBe(true);
    const wrong = await verifyReceipt({ ...anchored, anchor: { ...anchored.anchor, proof: [hex(keccak256(new Uint8Array([10])))] } }, { keys: [jwk] });
    expect(wrong.anchor).toBe("proof_invalid");
    expect(wrong.valid).toBe(false);
  });

  test("receiptLeaf is the double keccak of payload and signature", async () => {
    const r = real.receipt();
    expect(receiptLeaf(canonicalBytes(r.payload), Buffer.from(r.sig, "base64"))).toBe(r.leaf!);
  });
});
