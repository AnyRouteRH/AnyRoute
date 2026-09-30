import { canonicalJson } from "../src/lib/util.ts";

const digest = (v: unknown) => {
  if (typeof v !== "string") throw new Error("Attestation has no usable digest.");
  const m = /^(?:0x|sha256:)?([0-9a-fA-F]{64})$/.exec(v);
  if (!m) throw new Error("Attestation has no usable digest.");
  return `sha256:${m[1].toLowerCase()}`;
};

/** Draft only from a fresh router-verified sidecar record. Unknown pins remain empty and block publication. */
export function draftHostPolicy(record: any, modelId?: string, version = 1, now = new Date()) {
  const m = record?.measurement;
  if (record?.status !== "attested" || record?.checks?.quote_verified !== true || record?.checks?.digests_bound_to_quote !== true || m?.attested_now !== true || !record?.verifiers?.length)
    throw new Error("The public attestation record does not have fresh, verified, quote-bound sidecar digests.");
  if (!["tdx", "snp", "nvidia-cc"].includes(record.tee)) throw new Error("Unsupported hardware TEE kind.");
  digest(m.compose_hash); // A complete existing binding includes all three digests.
  return {
    version, issued_at: now.toISOString(), tee_kinds: [record.tee],
    sidecar: { image_digests: [digest(m.image_digest)], source_hashes: [] as string[] },
    engines: [] as { name: string; image_digest: string }[],
    models: [{ id: modelId ?? "", model_digest: digest(m.model_digest), min_gpu_cc: true }],
    rules: { require_gpu_cc_for: [] as string[], allow_dev: false },
  };
}

// Read-only: never signs or publishes. --model-id is an owner-supplied mapping, absent from the bound fields.
// bun scripts/network-policy.ts --base <router public URL> --provider <provider ID> --model-id <model ID>
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const arg = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const base = arg("--base");
    if (!base) throw new Error("Provide --base <router public URL>.");
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use a public HTTPS router URL without credentials.");
    const provider = arg("--provider") ?? "phala-qwen05b-tdx";
    const endpoint = new URL(`/api/v1/attestation/${encodeURIComponent(provider)}`, url);
    const res = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Public attestation API returned HTTP ${res.status}.`);
    const body = await res.json() as { data?: unknown };
    const version = Number(arg("--version") ?? "1");
    if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) throw new Error("Use a positive policy version.");
    process.stdout.write(canonicalJson(draftHostPolicy(body.data, arg("--model-id"), version)) + "\n");
    process.stderr.write("Draft only. Supply source hashes and engine image pins from reviewed build provenance, confirm the model ID mapping, and set min_gpu_cc deliberately. The public record does not expose those bindings or a GPU CC verification result. Empty required lists cannot be published. Current sidecars lack source, engine and model ID bindings, so the pure check refuses them. Publish explicitly using admin network.publishPolicy.\n");
  } catch (e) {
    process.stderr.write((e as Error).message + "\n");
    process.exitCode = 1;
  }
}
