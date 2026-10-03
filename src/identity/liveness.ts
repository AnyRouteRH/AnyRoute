import { and, eq, inArray, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { agentProfiles } from "../agents/profile-schema.ts";
import { providerFetch } from "../providers/network.ts";
import { log, sha256 } from "../lib/util.ts";
import { agentLiveness } from "./schema.ts";
import { signDocument } from "./signed.ts";

// Liveness of listed agents (job agent-liveness, daily by default; the canary job's pattern): one GET to each listed
// profile's declared endpoint, over HTTPS to a public address only, no redirects, no body read. The result is a probe
// receipt signed with the router's receipt key. live means the endpoint answered within the timeout with a status
// below 500 other than 404 and 410; 401, 402 and 403 count as live (an endpoint that asks for payment or a key is up).

export const LIVENESS_TYPE = "anyroute.agent.liveness-probe";
export type ProbeResult = { live: boolean; http_status: number | null; latency_ms: number | null; error: "timeout" | "network" | "blocked" | "http" | null };
export type Probe = (url: string, timeoutMs: number) => Promise<ProbeResult>;

export const isLiveStatus = (status: number) => status < 500 && status !== 404 && status !== 410;

export const probeEndpoint: Probe = async (url, timeoutMs) => {
  const started = Date.now();
  try {
    const res = await providerFetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "Anyroute-Liveness/1", accept: "application/json, text/html;q=0.5, */*;q=0.1" } }, { production: true });
    await res.body?.cancel().catch(() => undefined);
    const live = isLiveStatus(res.status);
    return { live, http_status: res.status, latency_ms: Date.now() - started, error: live ? null : "http" };
  } catch (e) {
    const name = (e as Error)?.name, message = String((e as Error)?.message ?? "");
    const error = name === "TimeoutError" || name === "AbortError" ? "timeout" : /non-public address|must use HTTPS|redirects are disabled|did not resolve/.test(message) ? "blocked" : "network";
    return { live: false, http_status: null, latency_ms: error === "timeout" ? timeoutMs : null, error };
  }
};

export async function runAgentLiveness(ctx: Ctx, opts: { probe?: Probe; limit?: number; now?: () => Date } = {}) {
  if (!ctx.cfg.identity.enabled || !ctx.cfg.agentProfilesEnabled) return { skipped: "not enabled" };
  const probe = opts.probe ?? probeEndpoint;
  const rows = await ctx.db.select({ slug: agentProfiles.slug, keyHash: agentProfiles.keyHash, endpoint: sql<string | null>`${agentProfiles.settings}->>'endpoint'` })
    .from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash))
    .where(and(eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`, sql`${agentProfiles.settings}->>'endpoint' is not null`))
    .orderBy(agentProfiles.slug).limit(opts.limit ?? 1000);
  let live = 0, down = 0;
  for (const row of rows) {
    if (!row.endpoint) continue;
    const result = await probe(row.endpoint, ctx.cfg.identity.livenessTimeoutMs).catch((): ProbeResult => ({ live: false, http_status: null, latency_ms: null, error: "network" }));
    const probedAt = (opts.now?.() ?? new Date());
    const endpointSha256 = sha256(row.endpoint);
    const receipt = signDocument(ctx, { version: 1, type: LIVENESS_TYPE, agent: row.slug, endpoint_sha256: endpointSha256, probed_at: probedAt.toISOString(), ...result });
    const values = { endpointSha256, live: result.live, httpStatus: result.http_status, latencyMs: result.latency_ms, error: result.error, probedAt, receipt };
    await ctx.db.insert(agentLiveness).values({ keyHash: row.keyHash, ...values }).onConflictDoUpdate({ target: agentLiveness.keyHash, set: values });
    if (result.live) live++; else down++;
  }
  if (down) log.info("agent liveness", { probed: live + down, live, down });
  return { probed: live + down, live, down };
}

/** The latest probe for each key whose endpoint is still the one probed; stale results for a changed endpoint are dropped. */
export async function latestLiveness(ctx: Ctx, rows: { keyHash: string; endpoint?: string }[]) {
  const wanted = rows.filter(r => r.endpoint);
  if (!wanted.length) return new Map<string, typeof agentLiveness.$inferSelect>();
  const found = await ctx.db.select().from(agentLiveness).where(inArray(agentLiveness.keyHash, wanted.map(r => r.keyHash)));
  const endpoints = new Map(wanted.map(r => [r.keyHash, sha256(r.endpoint!)]));
  return new Map(found.filter(f => endpoints.get(f.keyHash) === f.endpointSha256).map(f => [f.keyHash, f]));
}

export function livenessJson(row: typeof agentLiveness.$inferSelect | undefined) {
  if (!row) return { live: null, probed_at: null, receipt: null };
  return { live: row.live, probed_at: row.probedAt.toISOString(), http_status: row.httpStatus, receipt: row.receipt };
}
