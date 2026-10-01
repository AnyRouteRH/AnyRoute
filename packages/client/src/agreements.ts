import type { Fetch } from "./types.js";
import { requestError } from "./agent-errors.js";
export type AgreementPrepare = { payee: string; milestone_amounts_usdg_units: string[]; terms_hash: string; deadline: string };
export type AgreementTransaction = { chain_id: number; payer: string; to: string; value: "0"; data: string; notice: string };
/** Party-only REST adapter. Preparation always asks the router to check current inherited rulebooks. */
export function agreementClient(baseUrl: string, fetcher: Fetch, headers: () => Record<string, string>) {
  async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetcher(`${baseUrl}/api/v1/agreements${path}`, { method, signal, headers: { ...headers(), accept: "application/json", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await res.json().catch(() => null) as { data: T; error?: { message?: string; type?: string; metadata?: unknown } } | null;
    if (!res.ok || !json) throw requestError(json?.error?.message ?? `agreement request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
    return json.data;
  }
  const idPath = (id: string) => { if (!/^(0|[1-9]\d{0,77})\.(0|[1-9]\d?)$/.test(id)) throw new Error("Invalid agreement id."); return `/${id}`; };
  return {
    list: (signal?: AbortSignal) => request<Record<string, unknown>[]>("", "GET", undefined, signal),
    status: (id: string, signal?: AbortSignal) => request<Record<string, unknown>>(idPath(id), "GET", undefined, signal),
    evidence: (id: string, evidence: unknown, signal?: AbortSignal) => request<{ sha256: string; dispute: string }>(`${idPath(id)}/evidence`, "POST", evidence, signal),
    deleteEvidence: (id: string, signal?: AbortSignal) => request<{ removed: number }>(`${idPath(id)}/evidence`, "DELETE", undefined, signal),
    /** Returns unsigned calldata. The payer approves USDG and signs through its own wallet; no funds are held by the router. */
    prepare: (body: AgreementPrepare, signal?: AbortSignal) => request<AgreementTransaction>("/prepare", "POST", body, signal),
  };
}
