import type { Ctx } from "../context.ts";
import { decrypt } from "../lib/util.ts";

// Active health probes every 15s: a free GET /models per provider. A failure is recorded against
// every live offer of that provider (connection-level outage); passive traffic outcomes cover the
// per-model picture. Probes never spend money.

export async function runProbes(ctx: Ctx) {
  await ctx.catalog.ensureFresh();
  const live = [...ctx.catalog.providers.values()].filter((p) => p.status === "live" || p.status === "shadow");
  const results = await Promise.all(
    live.map(async (p) => {
      const t = performance.now();
      let ok = false;
      let status: number | null = null;
      try {
        const headers: Record<string, string> = { ...((p.headers as Record<string, string> | null) ?? {}) };
        if (p.apiKeyEnc) headers.authorization = `Bearer ${decrypt(ctx.cfg.appSecret, p.apiKeyEnc)}`;
        const res = await fetch(p.baseUrl.replace(/\/$/, "") + "/models", { headers, signal: AbortSignal.timeout(5_000) });
        status = res.status;
        ok = res.ok;
        await res.body?.cancel();
      } catch {
        ok = false;
      }
      const latency = performance.now() - t;
      const offers = [...ctx.catalog.offersByModel.values()].flat().filter((o) => o.providerId === p.id && o.status === "live");
      for (const o of offers)
        ctx.health.record({ modelId: o.modelId, providerId: p.id, ok, statusCode: status, errorKind: ok ? null : status && status >= 500 ? "http_5xx" : status === 429 ? "rate_limited" : status ? "provider_auth" : "connection", latencyMs: ok ? null : latency, source: "probe" });
      return { provider: p.id, ok, status, ms: Math.round(latency) };
    }),
  );
  return { probed: results.length, down: results.filter((r) => !r.ok).map((r) => r.provider) };
}
