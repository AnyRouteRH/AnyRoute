import { describe, expect, test } from "bun:test";
import { decodeReceiptHeader, EnclaveSigner, encodeReceiptHeader, keyIdOf, normalizeUsage, ReceiptIndex, ReceiptQueue, receiptLeaf, verifyReceipt, type ReceiptPayload } from "../src/receipts.ts";
import { canonicalBytes } from "../src/util.ts";

const payload = (over: Partial<ReceiptPayload> = {}): ReceiptPayload => ({
  v: 1,
  type: "anyroute.sidecar.receipt",
  id: "rcpt_" + "0".repeat(24),
  ts: 1_700_000_000_000,
  path: "/v1/chat/completions",
  status: 200,
  stream: false,
  complete: true,
  req_hash: `sha256:${"11".repeat(32)}`,
  resp_hash: `sha256:${"22".repeat(32)}`,
  model_digest: `sha256:${"33".repeat(32)}`,
  attestation_ref: "44".repeat(32),
  nullifier: "",
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  dev: false,
  ...over,
});

describe("receipt signing", () => {
  test("verifies against the public key and the key id", () => {
    const s = EnclaveSigner.generate();
    const env = s.sign(payload());
    expect(env.alg).toBe("Ed25519");
    expect(env.key_id).toBe(keyIdOf(s.publicKeyHex));
    expect(s.publicKeyHex).toHaveLength(64);
    expect(verifyReceipt(env, s.publicKeyHex)).toBe(true);
    expect(env.leaf).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("any change to the payload, signature, key or leaf breaks verification", () => {
    const s = EnclaveSigner.generate();
    const other = EnclaveSigner.generate();
    const env = s.sign(payload());
    expect(verifyReceipt({ ...env, payload: { ...env.payload, status: 500 } }, s.publicKeyHex)).toBe(false);
    expect(verifyReceipt({ ...env, payload: { ...env.payload, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }, s.publicKeyHex)).toBe(false);
    expect(verifyReceipt({ ...env, payload: { ...env.payload, dev: true } }, s.publicKeyHex)).toBe(false);
    expect(verifyReceipt({ ...env, leaf: "0x" + "00".repeat(32) }, s.publicKeyHex)).toBe(false);
    expect(verifyReceipt(env, other.publicKeyHex)).toBe(false);
    const sig = Buffer.from(env.sig, "base64");
    sig[0] ^= 1;
    expect(verifyReceipt({ ...env, sig: sig.toString("base64") }, s.publicKeyHex)).toBe(false);
    expect(verifyReceipt({ ...env, alg: "RS256" as "Ed25519" }, s.publicKeyHex)).toBe(false);
  });

  test("key order in the payload does not matter (canonical JSON)", () => {
    const s = EnclaveSigner.generate();
    const p = payload();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as ReceiptPayload;
    expect(canonicalBytes(reordered).equals(canonicalBytes(p))).toBe(true);
    expect(verifyReceipt({ ...s.sign(p), payload: reordered }, s.publicKeyHex)).toBe(true);
  });

  test("the leaf is the router's leaf: keccak256(keccak256(canonical || signature))", () => {
    // Vector produced by the router's own receiptLeaf() (src/receipts/merkle.ts) for the same inputs.
    expect(receiptLeaf(new TextEncoder().encode('{"a":1}'), new Uint8Array(64).fill(1))).toBe("0x" + ["534ca289a9a3eaa4", "2ef4fb6362826020", "dd275e944bde285d", "02e210f515756b77"].join(""));
  });

  test("header encoding round-trips", () => {
    const s = EnclaveSigner.generate();
    const env = s.sign(payload());
    const v = encodeReceiptHeader(env);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeReceiptHeader(v)).toEqual(env);
    expect(verifyReceipt(decodeReceiptHeader(v), s.publicKeyHex)).toBe(true);
  });

  test("each generated signer has its own key", () => {
    expect(EnclaveSigner.generate().publicKeyHex).not.toBe(EnclaveSigner.generate().publicKeyHex);
  });
});

describe("usage normalisation", () => {
  test("accepts chat, embeddings and responses-style usage, rejects the rest", () => {
    expect(normalizeUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(normalizeUsage({ prompt_tokens: 7, total_tokens: 7 })).toEqual({ prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 });
    expect(normalizeUsage({ input_tokens: 3, output_tokens: 4 })).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({ prompt_tokens: -1, total_tokens: 3 })).toBeNull();
    expect(normalizeUsage({ completion_tokens: 3 })).toBeNull();
    expect(normalizeUsage("x")).toBeNull();
  });
});

describe("receipt queue", () => {
  const env = (n: number) => EnclaveSigner.generate().sign(payload({ id: `rcpt_${String(n).padStart(24, "0")}` }));

  test("hands out batches after a cursor and drops what is acknowledged", () => {
    const q = new ReceiptQueue(100);
    for (let i = 1; i <= 5; i++) q.push(env(i));
    const first = q.pull(0, 2);
    expect(first.leaves.map((l) => l.seq)).toEqual([1, 2]);
    expect(first.head).toBe(5);
    expect(q.pull(2, 10).leaves.map((l) => l.seq)).toEqual([3, 4, 5]);
    expect(q.ack(3)).toEqual({ removed: 3, pending: 2 });
    expect(q.pull(0, 10).leaves.map((l) => l.seq)).toEqual([4, 5]);
    expect(q.pull(5, 10).leaves).toEqual([]);
    expect(q.push(env(6)).seq).toBe(6);
  });

  test("when full it drops the oldest leaves and counts them", () => {
    const q = new ReceiptQueue(3);
    for (let i = 1; i <= 5; i++) q.push(env(i));
    expect(q.pending).toBe(3);
    expect(q.dropped).toBe(2);
    expect(q.pull(0, 10).leaves.map((l) => l.seq)).toEqual([3, 4, 5]);
  });

  test("the index serves a receipt only to its owner", () => {
    const idx = new ReceiptIndex(2);
    const a = env(1);
    idx.add("k1", a);
    expect(idx.get(a.payload.id, "k1")).toEqual(a);
    expect(idx.get(a.payload.id, "k2")).toBeNull();
    idx.add("k1", env(2));
    idx.add("k1", env(3));
    expect(idx.get(a.payload.id, "k1")).toBeNull(); // evicted
  });
});
