// A small read-only client for the Hugging Face public API. Every call takes the fetch to use, so the day-zero
// pipeline and the creator claim flow are exercised in tests without a network.
//
//   GET {base}/api/models?filter=base_model:finetune:<repo>&sort=createdAt&direction=-1&limit=<n>   new derivatives
//   GET {base}/api/models/<repo>                                                                    model info + card data
//   GET {base}/<repo>/raw/<revision>/<path>                                                         one file's text
//
// Responses are size-bounded and parsed defensively: anything unexpected is an error or "not found", never a guess.

export type FetchFn = typeof fetch;

const REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const REVISION = /^[\w.-]{1,64}$/;
const FILE = /^[\w.-][\w./-]{0,127}$/;
const TIMEOUT_MS = 10_000;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_FILE = 16 * 1024;

export const isRepoId = (v: unknown): v is string => typeof v === "string" && REPO.test(v);

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error("Hugging Face response exceeds the size limit.");
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Hugging Face response exceeds the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getJson(f: FetchFn, url: string): Promise<{ status: number; json: unknown }> {
  const res = await f(url, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { status: 404, json: null };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Hugging Face returned HTTP ${res.status}`);
  }
  try {
    return { status: res.status, json: JSON.parse(await readBounded(res, MAX_JSON)) };
  } catch (e) {
    throw new Error(`Hugging Face returned an unreadable body (${(e as Error).message})`);
  }
}

export type HfListed = { id: string; tags: string[]; createdAt: string | null };

/** The newest repositories that declare `baseRepo` as the base of a fine-tune. */
export async function listDerived(f: FetchFn, base: string, baseRepo: string, limit: number): Promise<HfListed[]> {
  if (!isRepoId(baseRepo)) throw new Error(`${baseRepo} is not a repository id.`);
  const url = `${base}/api/models?filter=${encodeURIComponent(`base_model:finetune:${baseRepo}`)}&sort=createdAt&direction=-1&limit=${Math.max(1, Math.min(100, limit))}`;
  const { json } = await getJson(f, url);
  if (!Array.isArray(json)) throw new Error("Hugging Face returned an unexpected listing.");
  const out: HfListed[] = [];
  for (const item of json) {
    const o = item as Record<string, unknown>;
    const id = typeof o?.id === "string" ? o.id : typeof o?.modelId === "string" ? o.modelId : null;
    if (!id || !isRepoId(id)) continue;
    out.push({ id, tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [], createdAt: typeof o.createdAt === "string" ? o.createdAt : null });
  }
  return out;
}

export type HfModel = {
  id: string;
  /** The account or organisation that owns the repository. */
  owner: string;
  sha: string | null;
  createdAt: string | null;
  private: boolean;
  gated: boolean;
  disabled: boolean;
  /** Lower-cased license identifier from the model card, or null. */
  license: string | null;
  /** Base models named by the model card, lower-cased. */
  baseModels: string[];
  tags: string[];
};

const asList = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Model info and card metadata, or null when the repository does not exist. */
export async function modelInfo(f: FetchFn, base: string, repo: string): Promise<HfModel | null> {
  if (!isRepoId(repo)) throw new Error(`${repo} is not a repository id.`);
  const { status, json } = await getJson(f, `${base}/api/models/${repo}`);
  if (status === 404) return null;
  const o = json as Record<string, any>;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !isRepoId(o.id)) throw new Error("Hugging Face returned unexpected model info.");
  const card = (o.cardData && typeof o.cardData === "object" ? o.cardData : {}) as Record<string, unknown>;
  const cardLicense = asList(card.license)[0];
  const tagLicense = asList(o.tags).find((t) => t.startsWith("license:"))?.slice("license:".length);
  return {
    id: o.id,
    owner: o.id.split("/")[0],
    sha: typeof o.sha === "string" && /^[0-9a-f]{7,64}$/i.test(o.sha) ? o.sha.toLowerCase() : null,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : null,
    private: o.private === true,
    // `gated` is false, "auto" or "manual" on the API.
    gated: o.gated === true || o.gated === "auto" || o.gated === "manual",
    disabled: o.disabled === true,
    // The model card is what the license check reads; the license tag is the fallback the Hub derives from it.
    license: (cardLicense ?? tagLicense)?.toLowerCase() ?? null,
    baseModels: asList(card.base_model).map((b) => b.toLowerCase()),
    tags: asList(o.tags),
  };
}

/** The text of one small file at a revision of a repository, or null when it is absent. */
export async function repoFile(f: FetchFn, base: string, repo: string, revision: string, path: string): Promise<string | null> {
  if (!isRepoId(repo) || !REVISION.test(revision) || !FILE.test(path) || path.includes("..")) throw new Error("Not a valid repository file reference.");
  const res = await f(`${base}/${repo}/raw/${revision}/${path}`, { headers: { accept: "text/plain" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Hugging Face returned HTTP ${res.status}`);
  }
  return readBounded(res, MAX_FILE);
}
