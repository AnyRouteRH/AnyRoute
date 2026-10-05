import type { Fetch } from "./types.js";
import type { AgentPolicy } from "./agent.js";
import { requestError } from "./agent-errors.js";

/** A playbook: one named rulebook that many keys of an account or team follow. `version` counts rule changes. */
export type Playbook = {
  id: string; name: string; team_id: string | null; policy: AgentPolicy; sha256: string; version: number;
  created_at: string; updated_at: string; updated_by: string;
  /** Every key that follows the playbook; `keys` names the ones the calling key manages. */
  followers: number; keys: { key_hash: string; name: string | null }[]; can_edit: boolean;
};
export type PlaybookChange = { action: "create" | "update" | "rename" | "delete"; version: number; sha256: string; name: string; followers: number; at: string };
export type PlaybookFollowResult = { key_hash: string; changed: boolean; playbook: { id: string; name: string; version: number } | null; policy: AgentPolicy | null; sha256: string | null; killed: boolean; playbook_id: string | null };

/**
 * Playbooks, for a management key or a team owner/admin key. A change to a playbook applies to every key that follows it
 * from that key's next request. Same switch as rulebooks (AGENT_POLICY_ENABLED); disabled routes return 404.
 */
export function playbookClient(baseUrl: string, fetcher: Fetch, headers: () => Record<string, string>) {
  async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetcher(`${baseUrl}/api/v1${path}`, { method, signal, headers: { ...headers(), accept: "application/json", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await res.json().catch(() => null) as { data: T; error?: { message?: string; type?: string; metadata?: unknown } } | null;
    if (!res.ok || !json) throw requestError(json?.error?.message ?? `playbook request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
    return json.data;
  }
  const one = (id: string) => `/playbooks/${encodeURIComponent(id)}`;
  return {
    list: (signal?: AbortSignal) => request<Playbook[]>("/playbooks", "GET", undefined, signal),
    /** The playbook with its latest recorded changes, newest first. */
    get: (id: string, signal?: AbortSignal) => request<Playbook & { changes: PlaybookChange[] }>(one(id), "GET", undefined, signal),
    create: (body: { name: string; policy: AgentPolicy; team_id?: string | null }, signal?: AbortSignal) => request<Playbook>("/playbooks", "POST", body, signal),
    /** New rules raise the version and reach every following key; `changed` is false when nothing differs. */
    update: (id: string, body: { name?: string; policy?: AgentPolicy }, signal?: AbortSignal) => request<Playbook & { changed: boolean }>(one(id), "PUT", body, signal),
    /** Refused with playbook_followed while keys follow it, unless `unlink: "copy"`: each key then keeps the rules as its own. */
    delete: (id: string, options: { unlink?: "copy" } = {}, signal?: AbortSignal) => request<{ id: string; deleted: true; unlinked: number }>(one(id) + (options.unlink ? "?unlink=copy" : ""), "DELETE", undefined, signal),
    /** Make a key follow a playbook, or stop following with null (the key keeps the playbook's rules as its own). */
    follow: (keyHash: string, playbookId: string | null, signal?: AbortSignal) => request<PlaybookFollowResult>(`/agents/${encodeURIComponent(keyHash)}/playbook`, "POST", { playbook_id: playbookId }, signal),
  };
}
