import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { canonicalJson, normalizeDigest, SidecarError, type Logger } from "./util.ts";

// Model digest: a deterministic hash of the served weights.
//   1. Walk the model directory (a single file is also accepted), following symlinks to regular files.
//      Skip `.git`, `.cache` and `.DS_Store` entries and anything matching the configured exclude globs.
//   2. For each file compute sha256 of its content; identify it by its path relative to the model root, with "/"
//      separators.
//   3. Sort entries by the UTF-8 bytes of the relative path.
//   4. digest = sha256("anyroute-model-digest-v1\n" + JSON([[path, sha256], ...])) where the JSON is compact.
// The same directory contents give the same digest on any host, regardless of file timestamps or walk order.

export const MODEL_DIGEST_DOMAIN = "anyroute-model-digest-v1\n";
const DEFAULT_EXCLUDED_NAMES = new Set([".git", ".cache", ".DS_Store"]);

export type ManifestEntry = { path: string; sha256: string; size: number };
export type ModelHash = { digest: string; files: number; bytes: number; manifest: ManifestEntry[] };

export function digestFromManifest(entries: { path: string; sha256: string }[]): string {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const body = canonicalJson(sorted.map((e) => [e.path, e.sha256]));
  return `sha256:${createHash("sha256").update(MODEL_DIGEST_DOMAIN + body).digest("hex")}`;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

type Found = { rel: string; abs: string };

async function walk(root: string, exclude: Bun.Glob[]): Promise<Found[]> {
  const out: Found[] = [];
  const seenDirs = new Set<string>();
  async function visit(abs: string, rel: string) {
    const real = await realpath(abs);
    if (seenDirs.has(real)) throw new SidecarError("MODEL_UNREADABLE", `symlink loop in model directory at ${rel || "."}`);
    seenDirs.add(real);
    const names = await readdir(abs);
    for (const name of names) {
      if (DEFAULT_EXCLUDED_NAMES.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      if (exclude.some((g) => g.match(childRel))) continue;
      const childAbs = join(abs, name);
      let st;
      try {
        st = await stat(childAbs); // follows symlinks; a dangling link throws
      } catch (e) {
        throw new SidecarError("MODEL_UNREADABLE", `cannot read ${childRel}: ${(e as Error).message}`);
      }
      if (st.isDirectory()) await visit(childAbs, childRel);
      else if (st.isFile()) out.push({ rel: childRel, abs: childAbs });
    }
    seenDirs.delete(real);
  }
  await visit(root, "");
  return out;
}

export type HashOptions = { exclude?: string[]; concurrency?: number; logger?: Logger };

export async function hashModelPath(path: string, opts: HashOptions = {}): Promise<ModelHash> {
  let st;
  try {
    st = await stat(path);
  } catch (e) {
    throw new SidecarError("MODEL_UNREADABLE", `model path ${path} is not readable: ${(e as Error).message}`);
  }
  const files: Found[] = st.isDirectory()
    ? await walk(path, (opts.exclude ?? []).map((p) => new Bun.Glob(p)))
    : [{ rel: basename(path), abs: path }];
  if (!files.length) throw new SidecarError("MODEL_EMPTY", `model path ${path} contains no files to hash`);
  const manifest: ManifestEntry[] = new Array(files.length);
  let next = 0;
  let bytes = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const f = files[i];
      const size = (await stat(f.abs)).size;
      const sha256 = await sha256File(f.abs);
      manifest[i] = { path: f.rel.split(sep).join("/"), sha256, size };
      bytes += size;
      opts.logger?.("info", "hashed model file", { path: manifest[i].path, size });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, files.length)) }, worker));
  manifest.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { digest: digestFromManifest(manifest), files: manifest.length, bytes, manifest };
}

// ---- allow-list -----------------------------------------------------------------------------------

export type Allowlist = { modelDigests: Set<string>; composeHashes: Set<string>; classifierDigests: Set<string> };

/** One entry per line, `#` starts a comment. Entries are sha256 digests. */
export function parseAllowlistText(text: string, what: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line) out.push(normalizeDigest(line, `${what} entry`));
  }
  return out;
}

export type AllowlistSources = {
  modelDigests: string[];
  modelDigestsFile?: string;
  composeHashes: string[];
  composeHashesFile?: string;
  /** The in-enclave classifier's weights have their own list; a main-model entry never admits a classifier. */
  classifierDigests?: string[];
  classifierDigestsFile?: string;
};

export async function loadAllowlist(src: AllowlistSources, env: Record<string, string | undefined>): Promise<Allowlist> {
  const fromEnv = (v: string | undefined, what: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean).map((s) => normalizeDigest(s, what)) : []);
  const fromFile = async (path: string | undefined, what: string) => {
    if (!path) return [];
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      throw new SidecarError("ALLOWLIST_UNREADABLE", `cannot read ${what} allow-list ${path}: ${(e as Error).message}`);
    }
    return parseAllowlistText(text, what);
  };
  const model = [
    ...src.modelDigests.map((d) => normalizeDigest(d, "allowlist model digest")),
    ...(await fromFile(src.modelDigestsFile, "model digest")),
    ...fromEnv(env.SIDECAR_MODEL_ALLOWLIST, "SIDECAR_MODEL_ALLOWLIST"),
  ];
  const compose = [
    ...src.composeHashes.map((d) => normalizeDigest(d, "allowlist compose hash")),
    ...(await fromFile(src.composeHashesFile, "compose hash")),
    ...fromEnv(env.SIDECAR_COMPOSE_ALLOWLIST, "SIDECAR_COMPOSE_ALLOWLIST"),
  ];
  const classifier = [
    ...(src.classifierDigests ?? []).map((d) => normalizeDigest(d, "allowlist classifier digest")),
    ...(await fromFile(src.classifierDigestsFile, "classifier digest")),
    ...fromEnv(env.SIDECAR_CLASSIFIER_ALLOWLIST, "SIDECAR_CLASSIFIER_ALLOWLIST"),
  ];
  return { modelDigests: new Set(model), composeHashes: new Set(compose), classifierDigests: new Set(classifier) };
}

/** Checked before the weights are hashed, so a missing list fails in seconds rather than after an hour of hashing. */
export function assertModelAllowlistConfigured(allow: Allowlist): void {
  if (!allow.modelDigests.size) {
    throw new SidecarError("MODEL_ALLOWLIST_EMPTY", "no model digest allow-list is configured; refusing to start (set allowlist.model_digests, allowlist.model_digests_file or SIDECAR_MODEL_ALLOWLIST)");
  }
}

/** Refuse to start unless the served weights are on the allow-list. An empty list refuses everything. */
export function enforceModelPin(digest: string, allow: Allowlist): void {
  assertModelAllowlistConfigured(allow);
  if (!allow.modelDigests.has(digest)) {
    throw new SidecarError("MODEL_DIGEST_NOT_ALLOWED", `served model digest ${digest} is not in the allow-list; refusing to start`);
  }
}

/** Checked before the classifier weights are hashed, for the same reason as the model list. */
export function assertClassifierAllowlistConfigured(allow: Allowlist): void {
  if (!allow.classifierDigests.size) {
    throw new SidecarError("CLASSIFIER_ALLOWLIST_EMPTY", "the classifier is enabled but no classifier digest allow-list is configured; refusing to start (set allowlist.classifier_digests, allowlist.classifier_digests_file or SIDECAR_CLASSIFIER_ALLOWLIST)");
  }
}

/** Refuse to start unless the classifier's weights are on the classifier allow-list (not the model list). */
export function enforceClassifierPin(digest: string, allow: Allowlist): void {
  assertClassifierAllowlistConfigured(allow);
  if (!allow.classifierDigests.has(digest)) {
    throw new SidecarError("CLASSIFIER_DIGEST_NOT_ALLOWED", `classifier digest ${digest} is not in the classifier allow-list; refusing to start`);
  }
}

/** Compose hashes are enforced only when an allow-list for them is configured. */
export function enforceComposePin(hash: string | null, allow: Allowlist): void {
  if (!allow.composeHashes.size) return;
  if (!hash) throw new SidecarError("COMPOSE_HASH_MISSING", "a compose hash allow-list is configured but no compose hash is available; refusing to start");
  if (!allow.composeHashes.has(hash)) throw new SidecarError("COMPOSE_HASH_NOT_ALLOWED", `compose hash ${hash} is not in the allow-list; refusing to start`);
}
