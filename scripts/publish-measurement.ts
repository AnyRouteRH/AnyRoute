// Publish a provider's measurement bundle to a Sigstore Rekor v1 transparency log, and hand it to the router.
//
//   MEASUREMENT_SIGNING_KEY=<PEM or base64 PKCS#8 of an ECDSA P-256 key> \
//   bun scripts/publish-measurement.ts --provider <id> --router-url <router> [--compose <file>] [--dry-run] [--handover]
//
// What it does, in order:
//   1. Reads the public compose file (default sidecar/examples/phala/docker-compose.yml) and checks that its pins agree:
//      every image by digest, the source commit and tarball sha256, the weights sha256, and the model digest they imply.
//   2. Takes the quote-measured values (compose hash, image and model digest, MRTD) from the router's public attestation
//      record (--router-url), or from --compose-hash / --app-compose / --attest, and refuses to go on when they do not
//      match the compose file: a bundle must describe what is actually running.
//   3. Builds the bundle (canonical JSON), signs it with the measurement key, and builds the Rekor `hashedrekord` entry:
//      the bundle's sha256 as the artifact hash, the signature, and the public key.
//   4. --dry-run stops here and prints the bundle, its digest, the signature and the exact request body. Nothing is sent.
//   5. Otherwise POSTs the entry to REKOR_URL (default https://rekor.sigstore.dev), verifies what comes back (inclusion
//      proof, entry contents, and with REKOR_PUBLIC_KEY the checkpoint and signed entry timestamp), and writes the
//      publication record (uuid, log index, integrated time, inclusion proof, signed entry timestamp) to --out.
//   6. --handover gives the record to the router (ADMIN_TOKEN), which verifies the log entry itself.
//
// Other modes:  --resume <record>  hand an existing record to the router (no new log entry)
//               --verify <record>  check a record: signature, entry, inclusion proof (--offline uses the record's copy)
//
// A log entry is permanent. Running this twice publishes two entries, so it refuses when the router already holds a
// verified bundle for the same compose hash (--force overrides) and never overwrites an output file. The private key is
// read from the environment and is never printed or written.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  SIGNATURE_ALGORITHM,
  asBytes32,
  buildBundle,
  bundleBytes,
  digestHex,
  hashedrekordEntry,
  keyId,
  parseBundle,
  parsePrivateKey,
  parsePublicKey,
  publicKeyOf,
  sameKey,
  sha256Of,
  signBytes,
  tdxRegisters,
  verifyBundleEntry,
  verifySignature,
  type MeasurementBundle,
} from "../src/services/measurement-bundle.ts";
import { parseRekorEntry, type RawRekorEntry } from "../src/services/measurements.ts";
import { fetchRekorEntry, submitToRekor, withInclusionProof } from "../src/services/rekor-client.ts";
import { checkPins, parsePins, readAppCompose } from "./lib/compose-pins.ts";

type Deps = { env: Record<string, string | undefined>; fetch: typeof fetch; out: (s: string) => void; err: (s: string) => void; now: () => Date; wait?: (ms: number) => Promise<void> };
const USAGE = `usage: bun scripts/publish-measurement.ts --provider <id> [--router-url <url>] [--compose <file>] [--compose-hash <sha256:..>]
         [--app-compose <file>] [--attest <file>] [--mrtd <hex>]... [--rtmr3 <hex>]... [--pin-rtmr3] [--no-mrtd]
         [--created-at <iso>] [--rekor-url <url>] [--out <file>] [--dry-run] [--handover] [--force]
       bun scripts/publish-measurement.ts --resume <record> --router-url <url>     (hand over an existing record)
       bun scripts/publish-measurement.ts --verify <record> [--router-url <url> | --public-key <file>] [--offline]
environment: MEASUREMENT_SIGNING_KEY (publish), REKOR_URL, REKOR_PUBLIC_KEY, ADMIN_TOKEN (--handover / --resume)`;

class Stop extends Error {}
const stop = (msg: string): never => {
  throw new Stop(msg);
};

const trim = (u: string) => u.replace(/\/+$/, "");

async function readJson(res: Response, cap = 4 * 1024 * 1024): Promise<any> {
  const text = await res.text();
  if (text.length > cap) throw new Error("response too large");
  try {
    return JSON.parse(text);
  } catch {
    return { _text: text.slice(0, 300) };
  }
}

// Rekor v1 submission and reads live in src/services/rekor-client.ts; tests and callers import submitToRekor from here.
export { submitToRekor };

// ---- Inputs --------------------------------------------------------------------------------------------------

type Measured = { composeHash: string | null; /** other spellings of the same document that hash differently */ composeAlternatives?: string[]; imageDigest: string | null; modelDigest: string | null; mrtd: string | null; rtmr3: string | null; source: string };

function fromAttestDocument(text: string): Measured {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return stop("--attest is not JSON");
  }
  const quote = doc?.evidence?.quote ?? doc?.intel_quote;
  const regs = typeof quote === "string" ? tdxRegisters(quote) : null;
  const b = doc?.bindings ?? doc?.sidecar_bindings ?? {};
  const norm = (v: unknown) => (typeof v === "string" ? sha256Of(v) : null);
  return { composeHash: norm(b.compose_hash), imageDigest: norm(b.image_digest), modelDigest: norm(b.model_digest), mrtd: regs?.mrtd ?? null, rtmr3: regs?.rtmr3 ?? null, source: "--attest" };
}

async function fromRouter(f: typeof fetch, router: string, provider: string, allowStale: boolean): Promise<Measured> {
  const res = await f(`${router}/api/v1/attestation/${encodeURIComponent(provider)}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return stop(`the router answered HTTP ${res.status} for the attestation record of ${provider}`);
  const d = (await readJson(res))?.data;
  if (!d?.measurement) return stop(`the router has no measurement recorded for ${provider}`);
  if (d.status !== "attested" && !allowStale) return stop(`the router does not currently call ${provider} attested (status ${d.status}); publish after it attests, or pass --allow-stale`);
  const m = d.measurement;
  return { composeHash: sha256Of(m.compose_hash), imageDigest: sha256Of(m.image_digest), modelDigest: sha256Of(m.model_digest), mrtd: m.registers?.mrtd ?? null, rtmr3: m.registers?.rtmr3 ?? null, source: "the router's attestation record" };
}

const same = (a: string | null, b: string | null) => !a || !b || a === b;

// ---- main ----------------------------------------------------------------------------------------------------

export async function main(argv: string[], deps: Deps = { env: process.env, fetch, out: (s) => console.log(s), err: (s) => console.error(s), now: () => new Date() }): Promise<number> {
  let v;
  try {
    v = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        "router-url": { type: "string" },
        compose: { type: "string" },
        "compose-hash": { type: "string" },
        "app-compose": { type: "string" },
        attest: { type: "string" },
        mrtd: { type: "string", multiple: true },
        rtmr3: { type: "string", multiple: true },
        "pin-rtmr3": { type: "boolean" },
        "no-mrtd": { type: "boolean" },
        "created-at": { type: "string" },
        "rekor-url": { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean" },
        handover: { type: "boolean" },
        force: { type: "boolean" },
        "allow-stale": { type: "boolean" },
        resume: { type: "string" },
        verify: { type: "string" },
        offline: { type: "boolean" },
        "public-key": { type: "string" },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    deps.err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    const router = v["router-url"] ? trim(v["router-url"]) : null;
    const rekor = trim(v["rekor-url"] ?? deps.env.REKOR_URL ?? "https://rekor.sigstore.dev");
    if (v.verify) return await verifyRecord(v.verify, { router, rekor, publicKeyFile: v["public-key"], offline: !!v.offline }, deps);
    if (v.resume) return await handOver(JSON.parse(readFileSync(v.resume, "utf8")), router ?? stop("--resume needs --router-url"), deps);
    if (!v.provider) return (deps.err(USAGE), 2);
    return await publish({ ...v, provider: v.provider, router, rekor }, deps);
  } catch (e) {
    if (e instanceof Stop) {
      deps.err(`refused: ${e.message}`);
      return 1;
    }
    deps.err(`failed: ${(e as Error).message}`);
    return 1;
  }
}

type PublishOptions = {
  provider: string;
  router: string | null;
  rekor: string;
  compose?: string;
  "compose-hash"?: string;
  "app-compose"?: string;
  attest?: string;
  mrtd?: string[];
  rtmr3?: string[];
  "pin-rtmr3"?: boolean;
  "no-mrtd"?: boolean;
  "created-at"?: string;
  out?: string;
  "dry-run"?: boolean;
  handover?: boolean;
  force?: boolean;
  "allow-stale"?: boolean;
};

async function publish(o: PublishOptions, deps: Deps): Promise<number> {
  const keyText = deps.env.MEASUREMENT_SIGNING_KEY;
  if (!keyText) return stop("MEASUREMENT_SIGNING_KEY is not set (an ECDSA P-256 private key, PEM or base64 PKCS#8)");
  const privateKey = parsePrivateKey(keyText);
  const publicKey = publicKeyOf(privateKey);
  if (o.handover && !deps.env.ADMIN_TOKEN) return stop("--handover needs ADMIN_TOKEN");
  if (o.handover && !o.router) return stop("--handover needs --router-url");

  // 1. The public compose file and the pins it makes.
  const composeFile = o.compose ?? "sidecar/examples/phala/docker-compose.yml";
  if (!existsSync(composeFile)) return stop(`no such file: ${composeFile}`);
  const composeText = readFileSync(composeFile, "utf8");
  const pins = parsePins(composeText);
  const bad = checkPins(pins).filter((c) => !c.ok);
  if (bad.length) return stop(`the compose file's pins do not agree: ${bad.map((c) => `${c.id} (${c.detail})`).join("; ")}`);
  const source = pins.source!;
  const weights = pins.weights!;
  const modelDigest = pins.sidecar!.modelDigests[0]!;

  // 2. What the quote committed to.
  const measured: Measured[] = [];
  if (o.router) measured.push(await fromRouter(deps.fetch, o.router, o.provider, !!o["allow-stale"]));
  if (o.attest) {
    if (!existsSync(o.attest)) return stop(`no such file: ${o.attest}`);
    measured.push(fromAttestDocument(readFileSync(o.attest, "utf8")));
  }
  if (o["compose-hash"]) measured.push({ composeHash: sha256Of(o["compose-hash"], "--compose-hash"), imageDigest: null, modelDigest: null, mrtd: null, rtmr3: null, source: "--compose-hash" });
  if (o["app-compose"]) {
    if (!existsSync(o["app-compose"])) return stop(`no such file: ${o["app-compose"]}`);
    const app = readAppCompose(readFileSync(o["app-compose"], "utf8"));
    if (app.docker_compose_file !== composeText) return stop("the app-compose's docker_compose_file is not the compose file given (byte for byte)");
    measured.push({ composeHash: `sha256:${app.rawSha256}`, composeAlternatives: app.sortedSha256 === app.rawSha256 ? [] : [`sha256:${app.sortedSha256}`], imageDigest: null, modelDigest: null, mrtd: null, rtmr3: null, source: "--app-compose" });
  }
  if (!measured.length) return stop("no source for the compose hash: give --router-url, --compose-hash, --app-compose or --attest");
  const pick = <K extends keyof Measured>(k: K): Measured[K] => measured.find((m) => m[k])?.[k] ?? (null as Measured[K]);
  for (const k of ["imageDigest", "modelDigest"] as const)
    for (const a of measured) for (const b of measured) if (!same(a[k], b[k])) return stop(`${a.source} and ${b.source} disagree about the ${k}: ${a[k]} / ${b[k]}`);
  // The compose hash: the first source in the order router, attestation document, --compose-hash, --app-compose. The others
  // must agree with it; an app-compose.json agrees when its text, as given or with sorted keys, hashes to it.
  const composeHash = pick("composeHash") ?? stop("no source gave the compose hash");
  const spellings = (m: Measured) => [m.composeHash, ...(m.composeAlternatives ?? [])];
  for (const m of measured) if (m.composeHash && !spellings(m).includes(composeHash)) return stop(`${m.source} does not give the compose hash ${composeHash} (it gives ${spellings(m).join(" or ")})`);
  const only = measured.filter((m) => m.composeHash);
  if (only.length === 1 && only[0]!.composeAlternatives?.length) return stop(`the app-compose document alone does not fix the compose hash: its sha256 depends on how the text was serialised (as given ${only[0]!.composeHash}, keys sorted ${only[0]!.composeAlternatives[0]}). Also give --router-url or --compose-hash`);
  const imageDigest = pick("imageDigest");
  const measuredModel = pick("modelDigest");
  if (imageDigest && !pins.images.some((i) => i.digest === imageDigest)) return stop(`the image digest the quote committed to (${imageDigest}) is not an image in the compose file: the deployment is not running this file`);
  if (measuredModel && measuredModel !== modelDigest) return stop(`the model digest the quote committed to (${measuredModel}) is not the one this compose file allows (${modelDigest})`);

  // MRTD / RTMR3 allow-lists. RTMR3 changes with the CVM instance, so it is pinned only when asked for.
  const mrtd = [...(o.mrtd ?? []), ...(pick("mrtd") ? [pick("mrtd")!] : [])];
  const rtmr3 = [...(o.rtmr3 ?? []), ...(o["pin-rtmr3"] && pick("rtmr3") ? [pick("rtmr3")!] : [])];
  if (o["pin-rtmr3"] && !rtmr3.length) return stop("--pin-rtmr3 needs a source for RTMR3 (--router-url or --attest)");
  if (!mrtd.length && !o["no-mrtd"]) return stop("no MRTD for the allow-list: give --router-url, --attest or --mrtd (or --no-mrtd to publish without one)");
  for (const r of [...mrtd, ...rtmr3]) if (!/^(?:0x)?[0-9a-fA-F]{96}$/.test(r)) return stop("MRTD and RTMR3 values are 48 bytes, 96 hex characters");

  // 3. Build, sign, and shape the log entry.
  const bundle = buildBundle({
    provider: o.provider,
    createdAt: o["created-at"] ?? deps.now().toISOString(),
    composeHash,
    source: { repository: source.repository, commit: source.commit, path: source.path, tarballSha256: source.tarballSha256 },
    model: { digest: modelDigest, weights: [{ file: weights.file, sha256: weights.sha256, url: weights.url }] },
    images: pins.images,
    tdx: { mrtd, rtmr3 },
    publicKey,
  });
  const bytes = bundleBytes(bundle);
  const digest = digestHex(bytes);
  const signature = signBytes(bytes, privateKey);
  if (!verifySignature(bytes, signature, publicKey)) return stop("internal error: the fresh signature does not verify");
  const entry = hashedrekordEntry(bytes, signature, publicKey);

  if (o["dry-run"]) {
    deps.out(JSON.stringify({ dry_run: true, rekor_url: o.rekor, bundle, bundle_digest: `sha256:${digest}`, signature, signature_algorithm: SIGNATURE_ALGORITHM, signer_key_id: keyId(publicKey), rekor_request: { method: "POST", url: `${o.rekor}/api/v1/log/entries`, body: entry } }, null, 2));
    deps.err("dry run: nothing was sent to the log or the router.");
    return 0;
  }

  const outFile = o.out ?? `measurement-${o.provider}-${digest.slice(0, 8)}.publication.json`;
  if (existsSync(outFile)) return stop(`${outFile} exists; choose another --out (it is never overwritten)`);
  if (o.router && !o.force) {
    const res = await deps.fetch(`${o.router}/api/v1/measurements/bundles/${encodeURIComponent(o.provider)}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) }).catch(() => null);
    const list = res?.ok ? ((await readJson(res))?.data as { status: string; compose_hash: string; bundle_digest: string }[] | undefined) : undefined;
    const held = list?.find((b) => b.status === "verified" && b.compose_hash === asBytes32(composeHash));
    if (held) return stop(`the router already holds a verified bundle (${held.bundle_digest}) for this compose hash; pass --force to publish another entry`);
  }

  // 5. Submit, verify what came back, and keep the record before anything else can fail.
  const posted = await submitToRekor(deps.fetch, o.rekor, entry);
  const done = await withInclusionProof(deps.fetch, o.rekor, posted, deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
  const parsed = parseRekorEntry(done.uuid, done.raw);
  const check = verifyBundleEntry(parsed, { bytes, publicKey, rekorPublicKey: deps.env.REKOR_PUBLIC_KEY });
  if (!check.ok) return stop(`the log's entry ${done.uuid} does not verify: ${check.reason}. Nothing was handed to the router.`);
  const ip = done.raw.verification?.inclusionProof;
  const record = {
    type: "anyroute.measurement.publication",
    version: 1,
    bundle,
    bundle_digest: `sha256:${digest}`,
    signature,
    signature_algorithm: SIGNATURE_ALGORITHM,
    signer_key_id: keyId(publicKey),
    rekor: {
      url: o.rekor,
      uuid: done.uuid,
      already_existed: posted.existed,
      log_index: done.raw.logIndex ?? null,
      integrated_time: done.raw.integratedTime ?? null,
      log_id: done.raw.logID ?? null,
      entry_url: `${o.rekor}/api/v1/log/entries/${done.uuid}`,
      body: done.raw.body,
      inclusion_proof: ip ? { log_index: ip.logIndex, tree_size: ip.treeSize, root_hash: ip.rootHash, hashes: ip.hashes, checkpoint: ip.checkpoint ?? null } : null,
      signed_entry_timestamp: done.raw.verification?.signedEntryTimestamp ?? null,
      checkpoint_signature_verified: check.checkpointVerified,
      signed_entry_timestamp_verified: check.setVerified,
    },
    submitted_at: deps.now().toISOString(),
  };
  writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  deps.out(`published ${o.provider}: bundle sha256:${digest}`);
  deps.out(`  log entry   ${record.rekor.entry_url}`);
  deps.out(`  log index   ${record.rekor.log_index}, integrated ${record.rekor.integrated_time ? new Date(record.rekor.integrated_time * 1000).toISOString() : "?"}`);
  deps.out(`  verified    inclusion proof yes; checkpoint signature ${check.checkpointVerified ? "yes" : "no (set REKOR_PUBLIC_KEY to check it)"}; signed entry timestamp ${check.setVerified ? "yes" : "no"}`);
  deps.out(`  record      ${outFile}`);
  if (o.handover) return await handOver(record, o.router!, deps);
  deps.out(o.router ? `hand it to the router:  ADMIN_TOKEN=... bun scripts/publish-measurement.ts --resume ${outFile} --router-url ${o.router}` : "give the record to the router with --resume <record> --router-url <url>");
  return 0;
}

async function handOver(record: any, router: string, deps: Deps): Promise<number> {
  const token = deps.env.ADMIN_TOKEN;
  if (!token) return stop("handing a record to the router needs ADMIN_TOKEN");
  const uuid = record?.rekor?.uuid;
  const res = await deps.fetch(`${router}/trpc/measurements.submitBundle`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ bundle: record.bundle, signature: record.signature, ...(uuid ? { rekor_uuid: uuid } : {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const body = await readJson(res);
  if (!res.ok) return stop(`the router refused the bundle (HTTP ${res.status}): ${String(body?.error?.message ?? body?.error?.json?.message ?? body?._text ?? "").slice(0, 300)}`);
  const r = body?.result?.data ?? {};
  deps.out(`router: bundle ${r.bundle_digest ?? "?"} is ${r.status ?? "?"}${r.error ? ` (${r.error})` : ""}`);
  const log = r.transparency_log ?? {};
  deps.out(`  inclusion verified ${!!log.inclusion_verified}, checkpoint signature verified ${!!log.checkpoint_signature_verified}, signed entry timestamp verified ${!!log.signed_entry_timestamp_verified}`);
  if (r.status !== "verified") deps.out("  the router keeps checking; see GET /api/v1/measurements/bundles/<provider>");
  return r.status === "rejected" ? 1 : 0;
}

async function verifyRecord(file: string, o: { router: string | null; rekor: string; publicKeyFile?: string; offline: boolean }, deps: Deps): Promise<number> {
  const record = JSON.parse(readFileSync(file, "utf8"));
  const bundle: MeasurementBundle = parseBundle(record.bundle);
  const bytes = bundleBytes(bundle);
  const lines: string[] = [];
  const results: boolean[] = [];
  const line = (ok: boolean, text: string) => (results.push(ok), lines.push(`${ok ? "ok  " : "FAIL"} ${text}`));

  line(`sha256:${digestHex(bytes)}` === record.bundle_digest, `bundle digest ${record.bundle_digest}`);
  let trusted = parsePublicKey(bundle.signer.public_key_pem);
  let anchor = "the key inside the bundle (not independently checked)";
  if (o.publicKeyFile) {
    trusted = parsePublicKey(readFileSync(o.publicKeyFile, "utf8"));
    anchor = `the key in ${o.publicKeyFile}`;
  } else if (o.router) {
    const res = await deps.fetch(`${o.router}/api/v1/measurements/key`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return stop(`the router answered HTTP ${res.status} for its measurement key`);
    trusted = parsePublicKey((await readJson(res)).data.public_key_pem);
    anchor = "the key the router publishes";
  }
  line(sameKey(trusted, parsePublicKey(bundle.signer.public_key_pem)) && bundle.signer.key_id === keyId(trusted), `the bundle names ${anchor}`);
  line(verifySignature(bytes, record.signature, trusted), "the signature verifies over the bundle bytes");

  const uuid = String(record.rekor?.uuid ?? "");
  let raw: RawRekorEntry | null = null;
  if (o.offline) {
    const r = record.rekor;
    raw = { body: r?.body, integratedTime: r?.integrated_time, logID: r?.log_id, logIndex: r?.log_index, verification: { signedEntryTimestamp: r?.signed_entry_timestamp, inclusionProof: r?.inclusion_proof ? { logIndex: r.inclusion_proof.log_index, treeSize: r.inclusion_proof.tree_size, rootHash: r.inclusion_proof.root_hash, hashes: r.inclusion_proof.hashes, checkpoint: r.inclusion_proof.checkpoint ?? undefined } : undefined } };
  } else raw = (await fetchRekorEntry(deps.fetch, o.rekor, uuid)).raw;
  const check = verifyBundleEntry(parseRekorEntry(uuid, raw), { bytes, publicKey: trusted, rekorPublicKey: deps.env.REKOR_PUBLIC_KEY });
  line(check.ok, check.ok ? `log entry ${uuid} holds this bundle, is signed by that key and is included in the log${o.offline ? " (the record's copy)" : ""}` : `log entry ${uuid}: ${check.reason}`);
  if (check.ok) {
    lines.push(`note checkpoint signature ${check.checkpointVerified ? "verified" : "not verified (set REKOR_PUBLIC_KEY)"}; signed entry timestamp ${check.setVerified ? "verified" : "not verified (set REKOR_PUBLIC_KEY)"}`);
  }
  for (const l of lines) deps.out(l);
  return results.every(Boolean) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
