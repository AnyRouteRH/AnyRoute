import { describe, expect, test } from "bun:test";
import { bindingsDigest, bindingsObject, parseNonce, reportData, reportDataHex, ZERO_NONCE, type Bindings } from "../src/reportdata.ts";

import { canonicalJson, normalizeDigest, sha256Hex } from "../src/util.ts";

const rd = (b: Bindings) => reportData(b);

const base: Bindings = {
  tlsPubkey: "aa".repeat(91),
  receiptPubkey: "bb".repeat(32),
  imageDigest: `sha256:${"11".repeat(32)}`,
  composeHash: `sha256:${"22".repeat(32)}`,
  modelDigest: `sha256:${"33".repeat(32)}`,
};

describe("report data", () => {
  test("is sha256 of the canonical bindings followed by the nonce", () => {
    const rd = reportData(base);
    expect(rd.length).toBe(64);
    const expected = sha256Hex(canonicalJson({ compose_hash: base.composeHash, image_digest: base.imageDigest, model_digest: base.modelDigest, receipt_pubkey: base.receiptPubkey, tls_pubkey: base.tlsPubkey }));
    expect(Buffer.from(rd.subarray(0, 32)).toString("hex")).toBe(expected);
    expect(Buffer.from(rd.subarray(32)).toString("hex")).toBe("00".repeat(32));
  });

  test("a deployment with neither the classifier nor encryption derives the same report data as before they existed", () => {
    // Pinned from the derivation as it was when only the five keys existed.
    expect(reportDataHex(base)).toBe("fcef800632aeee291db94b84cdd8edc9bbabd796b240d06912e54f73c8c7d759" + "00".repeat(32));
    expect(Object.keys(bindingsObject(base)).sort()).toEqual(["compose_hash", "image_digest", "model_digest", "receipt_pubkey", "tls_pubkey"]);
  });

  test("the classifier and the encryption key are bound only when present, and each binding changes the digest", () => {
    const d0 = Buffer.from(bindingsDigest(base)).toString("hex");
    const withClassifier: Bindings = { ...base, classifier: { digest: `sha256:${"44".repeat(32)}`, policy: `sha256:${"55".repeat(32)}` } };
    const withHpke: Bindings = { ...base, hpkePubkey: "66".repeat(32) };
    expect(bindingsObject(withClassifier)).toMatchObject({ classifier_enabled: true, classifier_digest: `sha256:${"44".repeat(32)}`, classifier_policy: `sha256:${"55".repeat(32)}` });
    expect(bindingsObject(withHpke)).toMatchObject({ hpke_pubkey: "66".repeat(32) });
    expect("hpke_pubkey" in bindingsObject(withClassifier)).toBe(false);
    expect("classifier_enabled" in bindingsObject(withHpke)).toBe(false);
    const both: Bindings = { ...withClassifier, hpkePubkey: "66".repeat(32) };
    const digests = [withClassifier, withHpke, both].map((b) => Buffer.from(bindingsDigest(b)).toString("hex"));
    expect(new Set([d0, ...digests]).size).toBe(4);
    // Changing the classifier's digest or policy, or the key, changes the derivation.
    const change = (b: Bindings): string[] => [
      Buffer.from(bindingsDigest({ ...b, classifier: { ...b.classifier!, digest: `sha256:${"77".repeat(32)}` } })).toString("hex"),
      Buffer.from(bindingsDigest({ ...b, classifier: { ...b.classifier!, policy: `sha256:${"88".repeat(32)}` } })).toString("hex"),
      Buffer.from(bindingsDigest({ ...b, hpkePubkey: "99".repeat(32) })).toString("hex"),
    ];
    expect(new Set([...change(both), Buffer.from(bindingsDigest(both)).toString("hex")]).size).toBe(4);
    // The canonical form is what a verifier rebuilds from /attest.
    expect(Buffer.from(rd(both).subarray(0, 32)).toString("hex")).toBe(sha256Hex(canonicalJson(bindingsObject(both))));
  });

  test("every binding changes the digest", () => {
    const d0 = Buffer.from(bindingsDigest(base)).toString("hex");
    for (const k of Object.keys(base) as (keyof Bindings)[]) {
      const changed = { ...base, [k]: base[k] + "0" } as Bindings;
      expect(Buffer.from(bindingsDigest(changed)).toString("hex")).not.toBe(d0);
    }
  });

  test("a nonce lands in the second half and only there", () => {
    const nonce = new Uint8Array(32).fill(7);
    const a = reportDataHex(base);
    const b = reportDataHex(base, nonce);
    expect(b.slice(0, 64)).toBe(a.slice(0, 64));
    expect(b.slice(64)).toBe("07".repeat(32));
    expect(() => reportData(base, new Uint8Array(31))).toThrow();
    expect(ZERO_NONCE.length).toBe(32);
  });

  test("nonce parsing accepts exactly 32 hex bytes", () => {
    expect(parseNonce("ab".repeat(32))?.length).toBe(32);
    expect(parseNonce("0x" + "ab".repeat(32))?.length).toBe(32);
    expect(parseNonce("ab".repeat(31))).toBeNull();
    expect(parseNonce("zz".repeat(32))).toBeNull();
  });
});

describe("digest normalisation", () => {
  test("accepts sha256:, 0x and bare hex, rejects the rest", () => {
    const hex = "ab".repeat(32);
    expect(normalizeDigest(`sha256:${hex.toUpperCase()}`)).toBe(`sha256:${hex}`);
    expect(normalizeDigest(`0x${hex}`)).toBe(`sha256:${hex}`);
    expect(normalizeDigest(hex)).toBe(`sha256:${hex}`);
    expect(() => normalizeDigest("sha256:abcd")).toThrow();
    expect(() => normalizeDigest("md5:" + hex)).toThrow();
  });
});
