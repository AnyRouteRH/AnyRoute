import { describe, expect, test } from "bun:test";
import { bytesToHex, concatBytes, fetchHostAnchorProof, hexToBytes, keccak256, providerIdHash, readAttestedAnchor, verifyHostAnchor, type AttestedAnchor, type BoundIdentity, type HostAnchorProof } from "../src/index.js";
import { json, real, stubFetch } from "./helpers.js";

// A sidecar receipt captured from a TDX deployment, under a per-host root built the way the router builds it.

const status = (v: { checks: { id: string; status: string }[] }, id: string) => v.checks.find((c) => c.id === id)?.status;
const pair = (a: string, b: string) => {
  const [x, y] = [hexToBytes(a), hexToBytes(b)];
  return "0x" + bytesToHex(keccak256(bytesToHex(x) < bytesToHex(y) ? concatBytes(x, y) : concatBytes(y, x)));
};
const SIBLING = "0x" + "5a".repeat(32);

function fixture() {
  const receipt = real.receipt();
  const boot = real.boot();
  const proof: HostAnchorProof = {
    rid: receipt.payload.id as string,
    leaf: receipt.leaf!,
    rooted: true,
    anchored: true,
    status: "confirmed",
    provider: "example-provider",
    provider_id_hash: providerIdHash("example-provider"),
    attestation_ref: boot.attestation_ref,
    receipt_key: { key_id: boot.receipt_key.key_id, public_key: boot.bindings.receipt_pubkey },
    root_id: 1,
    root: pair(receipt.leaf!, SIBLING),
    leaf_index: 0,
    proof: [SIBLING],
    count: 2,
    anchor_index: 3,
    tx: "0x" + "ab".repeat(32),
    block: 12,
    chain: 4663,
    contract: "0x" + "0c".repeat(20),
  };
  const onchain: AttestedAnchor = { providerId: proof.provider_id_hash, root: proof.root, attestationRef: "0x" + proof.attestation_ref, anchoredAt: 1_790_000_000 };
  const bound: BoundIdentity = {
    attestationRef: boot.attestation_ref,
    attestationSan: boot.attestation_san,
    tlsPubkey: boot.bindings.tls_pubkey,
    receiptPubkey: boot.bindings.receipt_pubkey,
    receiptKeyId: boot.receipt_key.key_id,
    hpkePubkey: null,
    imageDigest: boot.bindings.image_digest.slice(7),
    composeHash: boot.bindings.compose_hash.slice(7),
    modelDigest: boot.bindings.model_digest,
    measurements: null,
    teeKind: "tdx",
  };
  return { receipt, proof, onchain, bound };
}

describe("verifyHostAnchor", () => {
  test("passes in order: signature under the bound key, the path to the root, the root on chain", async () => {
    const { receipt, proof, onchain, bound } = fixture();
    const v = await verifyHostAnchor(receipt, proof, { bound, readAnchor: async (i) => (i === 3 ? onchain : null), requireOnChain: true, providerId: "example-provider" });
    expect(v.valid).toBe(true);
    expect(v.onChain).toBe("match");
    expect(v.leaf).toBe(receipt.leaf!);
    const ids = v.checks.map((c) => c.id);
    expect(ids.indexOf("signature")).toBeLessThan(ids.indexOf("host.inclusion"));
    expect(ids.indexOf("host.inclusion")).toBeLessThan(ids.indexOf("host.onchain"));
    // Everything passes except the key window, which a raw enclave key does not have.
    for (const c of v.checks) expect([c.id, c.status]).toEqual([c.id, c.id === "key_window" ? "not_checked" : "pass"]);
  });

  test("without a reader the root on chain is not checked, and a root kept off chain says so", async () => {
    const { receipt, proof } = fixture();
    const v = await verifyHostAnchor(receipt, proof);
    expect(v.valid).toBe(true);
    expect(status(v, "host.onchain")).toBe("not_checked");
    expect(v.notChecked.join(" ")).toMatch(/bound/);
    const local = { ...proof, anchored: false, status: "local", anchor_index: null, tx: null, block: null };
    expect(await verifyHostAnchor(receipt, local)).toMatchObject({ valid: true, onChain: "off_chain" });
    expect(await verifyHostAnchor(receipt, local, { requireOnChain: true })).toMatchObject({ valid: false, onChain: "off_chain" });
    expect((await verifyHostAnchor(receipt, proof, { requireOnChain: true })).valid).toBe(false);
  });

  test("fails for a changed receipt, a wrong path, another attestation, key or provider, and a different on-chain record", async () => {
    const { receipt, proof, onchain, bound } = fixture();
    const fails = async (r: typeof receipt, p: HostAnchorProof, o: Parameters<typeof verifyHostAnchor>[2] = {}) => expect((await verifyHostAnchor(r, p, o)).valid).toBe(false);
    await fails({ ...receipt, payload: { ...receipt.payload, status: 500 } }, proof);
    await fails(receipt, { ...proof, proof: ["0x" + "5b".repeat(32)] });
    await fails(receipt, { ...proof, root: "0x" + "00".repeat(32) });
    await fails(receipt, { ...proof, leaf: SIBLING });
    await fails(receipt, { ...proof, attestation_ref: "ee".repeat(32) });
    await fails(receipt, { ...proof, receipt_key: { ...proof.receipt_key, key_id: "0000000000000000" } }, { bound });
    await fails(receipt, { ...proof, provider_id_hash: providerIdHash("someone-else") });
    await fails(receipt, proof, { providerId: "someone-else" });
    await fails(receipt, proof, { bound: { ...bound, attestationRef: "ee".repeat(32) } });
    await fails(receipt, proof, { readAnchor: async () => ({ ...onchain, root: "0x" + "77".repeat(32) }) });
    await fails(receipt, proof, { readAnchor: async () => ({ ...onchain, attestationRef: "0x" + "ee".repeat(32) }) });
    await fails(receipt, proof, { readAnchor: async () => null });
    await fails(receipt, proof, { readAnchor: async () => Promise.reject(new Error("rpc down")) });
  });
});

describe("readAttestedAnchor and fetchHostAnchorProof", () => {
  test("reads ReceiptAnchor.attestedAnchors over eth_call", async () => {
    const { onchain } = fixture();
    const word = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
    const encoded = "0x" + word(onchain.providerId) + word(onchain.root) + word(onchain.attestationRef) + word(onchain.anchoredAt.toString(16));
    const { fetch, calls } = stubFetch({ "POST /rpc": async ({ init }) => {
      const body = JSON.parse(String(init?.body));
      const index = parseInt(body.params[0].data.slice(10), 16);
      return json({ jsonrpc: "2.0", id: 1, result: index === 3 ? encoded : "0x" + "00".repeat(128) });
    } });
    const read = readAttestedAnchor("https://rpc.example/rpc", "0x" + "0c".repeat(20), fetch);
    expect(await read(3)).toEqual(onchain);
    expect(await read(4)).toBeNull();
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent).toMatchObject({ method: "eth_call", params: [{ to: "0x" + "0c".repeat(20), data: "0xa1bb37fb" + "3".padStart(64, "0") }, "latest"] });
  });

  test("fetches the proof by leaf or by receipt, and null when no root holds it", async () => {
    const { receipt, proof } = fixture();
    const { fetch, calls } = stubFetch({
      [`/api/v1/host-anchors/proof/${receipt.leaf}`]: () => json({ data: proof }),
      "POST /api/v1/host-anchors/proof": () => json({ data: proof }),
    });
    expect(await fetchHostAnchorProof("https://router.example/", receipt.leaf!, fetch)).toEqual(proof);
    expect(await fetchHostAnchorProof("https://router.example", receipt, fetch)).toEqual(proof);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ receipt });
    expect(await fetchHostAnchorProof("https://router.example", "0x" + "01".repeat(32), fetch)).toBeNull();
  });
});
