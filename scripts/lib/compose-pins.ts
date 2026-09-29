import { createHash } from "node:crypto";
import { basename } from "node:path";
import { parse } from "yaml";
import { digestFromManifest } from "../../sidecar/src/digest.ts";

// What a pinned dstack compose file (sidecar/examples/phala/docker-compose.yml) commits to, read out of the file itself:
// every image by digest, the sidecar source by commit and tarball sha256, the model weights by revision URL and sha256, and
// the model digest the sidecar will accept. dstack measures a hash of this file (inside app-compose.json) into RTMR3, so
// each of these pins is covered by the compose hash.

export type ImagePin = { service: string; reference: string; digest: string };
export type SourcePin = { repository: string; owner: string; name: string; commit: string; path: string; tarballSha256: string; tarballUrl: string };
export type WeightsPin = { file: string; sha256: string; url: string };
export type ComposePins = {
  images: ImagePin[];
  unpinned: string[];
  source: SourcePin | null;
  weights: WeightsPin | null;
  /** The sidecar configuration's model allow-list and declared image digest. */
  sidecar: { modelDigests: string[]; imageDigest: string | null; modelPath: string | null } | null;
  /** sha256 of the model manifest the weights pin implies (same derivation as `bun sidecar/src/main.ts digest`). */
  derivedModelDigest: string | null;
};

const HEX64 = /^[0-9a-f]{64}$/;
const commandText = (svc: Record<string, unknown>): string => {
  const c = svc.command;
  return Array.isArray(c) ? c.map(String).join("\n") : typeof c === "string" ? c : "";
};

export function parsePins(composeText: string): ComposePins {
  const doc = parse(composeText) as { services?: Record<string, Record<string, any>> } | null;
  const services = doc?.services ?? {};
  const images: ImagePin[] = [];
  const unpinned: string[] = [];
  let source: SourcePin | null = null;
  let weights: WeightsPin | null = null;
  let sidecar: ComposePins["sidecar"] = null;

  for (const [service, svc] of Object.entries(services)) {
    const image = typeof svc.image === "string" ? svc.image : null;
    if (image) {
      const m = /^(.+)@sha256:([0-9a-f]{64})$/.exec(image);
      if (m) images.push({ service, reference: m[1]!, digest: `sha256:${m[2]}` });
      else unpinned.push(`${service}: ${image}`);
    }
    const cmd = commandText(svc);
    const rev = /(?:^|\s)rev=([0-9a-f]{40})\b/.exec(cmd)?.[1];
    const sum = /(?:^|\s)sum=([0-9a-f]{64})\b/.exec(cmd)?.[1];
    const url = /(?:^|\s)url=(https:\/\/\S+)/.exec(cmd)?.[1];
    const gh = /https:\/\/codeload\.github\.com\/([^/\s'"]+)\/([^/\s'"]+)\/tar\.gz\//.exec(cmd);
    if (gh && rev && sum) {
      const path = /--strip-components=1\s+"?[^"\s/]+\/([^"\s]+)"?/.exec(cmd)?.[1] ?? "";
      source = { repository: `https://github.com/${gh[1]}/${gh[2]}`, owner: gh[1]!, name: gh[2]!, commit: rev, path, tarballSha256: `sha256:${sum}`, tarballUrl: `https://codeload.github.com/${gh[1]}/${gh[2]}/tar.gz/${rev}` };
    } else if (url && sum && !gh) {
      const file = /(?:^|\s)f=(\S+)/.exec(cmd)?.[1];
      if (file) weights = { file: basename(file), sha256: `sha256:${sum}`, url };
    }
    const cfgText = svc.environment && typeof svc.environment === "object" ? (svc.environment as Record<string, unknown>).SIDECAR_CONFIG_YAML : null;
    if (typeof cfgText === "string") {
      const cfg = parse(cfgText) as { allowlist?: { model_digests?: unknown }; image_digest?: unknown; model?: { path?: unknown } } | null;
      sidecar = {
        modelDigests: Array.isArray(cfg?.allowlist?.model_digests) ? cfg!.allowlist!.model_digests.map(String) : [],
        imageDigest: typeof cfg?.image_digest === "string" ? cfg.image_digest : null,
        modelPath: typeof cfg?.model?.path === "string" ? cfg.model.path : null,
      };
    }
  }

  // The digest the sidecar computes over a single weights file: its base name and content hash.
  let derivedModelDigest: string | null = null;
  if (weights && sidecar?.modelPath && basename(sidecar.modelPath) === weights.file) derivedModelDigest = digestFromManifest([{ path: weights.file, sha256: weights.sha256.slice(7) }]);
  return { images, unpinned, source, weights, sidecar, derivedModelDigest };
}

export type PinCheck = { id: string; ok: boolean; detail: string };

/** Consistency of the pins with one another. Every entry is a claim the file makes about itself, checked without a network. */
export function checkPins(p: ComposePins): PinCheck[] {
  const checks: PinCheck[] = [];
  checks.push({ id: "images_pinned", ok: p.unpinned.length === 0 && p.images.length > 0, detail: p.unpinned.length ? `not pinned by digest: ${p.unpinned.join(", ")}` : `${p.images.length} image(s) pinned by digest` });
  checks.push({ id: "source_pinned", ok: !!p.source && HEX64.test(p.source.tarballSha256.slice(7)), detail: p.source ? `${p.source.repository} @ ${p.source.commit}, tarball ${p.source.tarballSha256}` : "no source tarball pin (rev and sum) found" });
  checks.push({ id: "weights_pinned", ok: !!p.weights, detail: p.weights ? `${p.weights.file} ${p.weights.sha256} from ${p.weights.url}` : "no weights pin (url and sum) found" });
  const declared = p.sidecar?.imageDigest ?? null;
  checks.push({ id: "declared_image_is_pinned", ok: !!declared && p.images.some((i) => i.digest === declared), detail: declared ? `the sidecar declares image_digest ${declared}` : "the sidecar configuration declares no image_digest" });
  const allow = p.sidecar?.modelDigests ?? [];
  checks.push({
    id: "model_digest_derives_from_weights",
    ok: !!p.derivedModelDigest && allow.length === 1 && allow[0] === p.derivedModelDigest,
    detail: p.derivedModelDigest ? `weights pin implies ${p.derivedModelDigest}; the sidecar allows ${allow.join(", ") || "nothing"}` : "the weights pin does not determine the model digest",
  });
  return checks;
}

// ---- app-compose.json ------------------------------------------------------------------------------------

export type AppCompose = { raw: string; docker_compose_file: string | null; rawSha256: string; sortedSha256: string };

const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** An app-compose.json, given as the file itself or wrapped in a platform attestation document (`tcb_info.app_compose`,
 *  `app_compose` or `compose_file`; an object or the JSON string; `tcb_info` may itself be a JSON string). dstack's compose hash is the sha256 of the app-compose string. The hash is
 *  reported over the text exactly as given, and over a key-sorted re-serialisation, since a wrapper may reformat it. */
export function readAppCompose(text: string): AppCompose {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("app-compose is not JSON");
  }
  let tcb = doc?.tcb_info;
  if (typeof tcb === "string") {
    try {
      tcb = JSON.parse(tcb);
    } catch {
      tcb = null;
    }
  }
  const wrapped = tcb?.app_compose ?? doc?.app_compose ?? doc?.compose_file ?? null;
  const inner = typeof doc?.docker_compose_file === "string" ? doc : typeof wrapped === "string" ? JSON.parse(wrapped) : wrapped;
  if (!inner || typeof inner !== "object") throw new Error("no app-compose document found");
  const raw = typeof doc?.docker_compose_file === "string" ? text : typeof wrapped === "string" ? wrapped : JSON.stringify(inner);
  return { raw, docker_compose_file: typeof inner.docker_compose_file === "string" ? inner.docker_compose_file : null, rawSha256: sha(raw), sortedSha256: sha(JSON.stringify(sortKeys(inner))) };
}
