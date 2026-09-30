import type { RawRekorEntry } from "./measurements.ts";

// Writing to a Sigstore Rekor v1 log and reading an entry back. Shared by scripts/publish-measurement.ts (measurement
// bundles) and the transparency log's public-log anchoring (src/tlog/rekor.ts); the checks on what comes back are
// verifyBundleEntry (measurement-bundle.ts) over parseRekorEntry (measurements.ts).

/** An HTTP answer from Rekor that is not what the call needed. `status` is the HTTP status (0 when the answer was not
 *  an entry at all). */
export class RekorHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const HEX_UUID = /^(?:[0-9a-f]{16})?[0-9a-f]{64}$/;

async function readJson(res: Response, cap = 4 * 1024 * 1024): Promise<any> {
  const text = await res.text();
  if (text.length > cap) throw new RekorHttpError(0, "response too large");
  try {
    return JSON.parse(text);
  } catch {
    return { _text: text.slice(0, 300) };
  }
}

/** POST an entry to `<base>/api/v1/log/entries`. An entry the log already holds (409) is read back instead. */
export async function submitToRekor(f: typeof fetch, base: string, entry: object): Promise<{ uuid: string; raw: RawRekorEntry; existed: boolean }> {
  const res = await f(`${base}/api/v1/log/entries`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(entry), redirect: "error", signal: AbortSignal.timeout(60_000) });
  const body = await readJson(res);
  if (res.status === 409) {
    const uuid = /([0-9a-f]{64,80})/.exec(res.headers.get("location") ?? "")?.[1] ?? /([0-9a-f]{64,80})/.exec(String(body?.message ?? ""))?.[1];
    if (!uuid) throw new RekorHttpError(409, "Rekor says the entry exists but did not say where");
    return { ...(await fetchRekorEntry(f, base, uuid)), existed: true };
  }
  if (res.status !== 201 && res.status !== 200) throw new RekorHttpError(res.status, `Rekor answered HTTP ${res.status}: ${String(body?.message ?? body?._text ?? "").slice(0, 200)}`);
  const [uuid, raw] = Object.entries(body ?? {})[0] ?? [];
  if (!uuid || !HEX_UUID.test(uuid) || !raw || typeof (raw as RawRekorEntry).body !== "string") throw new RekorHttpError(0, "Rekor's answer has no entry");
  return { uuid, raw: raw as RawRekorEntry, existed: false };
}

/** GET one entry by uuid, exactly as the log returns it. */
export async function fetchRekorEntry(f: typeof fetch, base: string, uuid: string): Promise<{ uuid: string; raw: RawRekorEntry }> {
  const res = await f(`${base}/api/v1/log/entries/${uuid}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new RekorHttpError(res.status, `Rekor answered HTTP ${res.status} for entry ${uuid}`);
  const raw = Object.values((await readJson(res)) ?? {})[0] as RawRekorEntry | undefined;
  if (!raw || typeof raw.body !== "string") throw new RekorHttpError(0, "Rekor's answer has no entry");
  return { uuid, raw };
}

/** The entry with its inclusion proof: the answer to the POST carries one from current Rekor; an older server needs a
 *  short wait and a GET. Gives up after `tries` reads and returns the entry as it last was. */
export async function withInclusionProof(f: typeof fetch, base: string, e: { uuid: string; raw: RawRekorEntry }, wait: (ms: number) => Promise<void>, tries = 10) {
  let cur = e;
  for (let i = 0; i < tries && !cur.raw.verification?.inclusionProof; i++) {
    await wait(1000);
    cur = await fetchRekorEntry(f, base, e.uuid);
  }
  return cur;
}
