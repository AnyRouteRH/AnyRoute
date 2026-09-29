import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildBundle, bundleBytes, digestHex, hashedrekordEntry, publicKeyOf, publicKeyPem, signBytes, type BundleParts, type MeasurementBundle } from "../src/services/measurement-bundle.ts";
import { DIGESTS, REGS } from "./measurement-fixtures.ts";

// A measurement key and bundles for the tests. The digests are the ones measurement-fixtures.ts puts in sidecar bindings
// and quotes, so a bundle built here describes a measurement the attestor tests record.

export function newSigner() {
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicPem: publicKeyPem(kp.publicKey), privatePem: kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
export type Signer = ReturnType<typeof newSigner>;

export const COMPOSE_TEXT = readFileSync(new URL("../sidecar/examples/phala/docker-compose.yml", import.meta.url), "utf8");

export const PROVIDER = "alpha";
export const LLAMA_IMAGE = "sha256:" + "44".repeat(32);

export function partsFor(publicKey: KeyObject, over: Partial<BundleParts> = {}): BundleParts {
  return {
    provider: PROVIDER,
    createdAt: "2026-09-29T10:00:00.000Z",
    composeHash: DIGESTS.compose,
    source: { repository: "https://github.com/example-org/example-repo", commit: "ab".repeat(20), path: "sidecar", tarballSha256: "sha256:" + "55".repeat(32) },
    model: { digest: DIGESTS.model, weights: [{ file: "model.gguf", sha256: "sha256:" + "66".repeat(32), url: "https://models.example.test/model.gguf" }] },
    images: [
      { service: "sidecar", reference: "example/sidecar:1", digest: DIGESTS.image },
      { service: "llama", reference: "example/llama:1", digest: LLAMA_IMAGE },
    ],
    tdx: { mrtd: [REGS.mrtd], rtmr3: [] },
    publicKey,
    ...over,
  };
}

export function signedBundle(signer: Signer, over: Partial<BundleParts> = {}) {
  const bundle: MeasurementBundle = buildBundle(partsFor(signer.publicKey, over));
  const bytes = bundleBytes(bundle);
  const signature = signBytes(bytes, signer.privateKey);
  return { bundle, bytes, digest: digestHex(bytes), signature, entry: hashedrekordEntry(bytes, signature, publicKeyOf(signer.privateKey)) };
}
