// Seed providers from a YAML file (PROVIDERS_FILE or argv[2]) and import their catalogs.
//   bun scripts/seed.ts config/providers.yaml
// Provider API keys are read from the environment variable named by `api_key_env`; they are
// encrypted at rest with APP_SECRET and never printed.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { openDatabase } from "../src/db/client.ts";
import { loadConfig } from "../src/config.ts";
import { providers } from "../src/db/schema.ts";
import { encrypt } from "../src/lib/util.ts";

const file = process.argv[2] ?? process.env.PROVIDERS_FILE;
if (!file) {
  console.error("usage: bun scripts/seed.ts <providers.yaml>");
  process.exit(2);
}
const spec = z.object({
  providers: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
      name: z.string(),
      base_url: z.string().url(),
      api_key_env: z.string().optional(),
      status: z.enum(["applied", "shadow", "live"]).default("shadow"),
      data_policy: z.object({ training: z.boolean(), retains_prompts: z.boolean(), retention_days: z.number().optional(), zdr: z.boolean().optional() }),
      datacenters: z.array(z.string()).default([]),
      tee: z.object({ kind: z.enum(["tdx", "snp", "nvidia-cc", "tinfoil", "dev"]), attestation_url: z.string().url() }).optional(),
      payout_address: z.string().optional(),
      timeout_ms: z.number().int().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      models: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
  ),
});
const doc = spec.parse(parse(readFileSync(file, "utf8")));
const cfg = loadConfig();
const { db, close } = await openDatabase(cfg.databaseUrl);
for (const p of doc.providers) {
  const key = p.api_key_env ? process.env[p.api_key_env] : undefined;
  if (p.api_key_env && !key) console.warn(`! ${p.id}: ${p.api_key_env} is not set; calls to it will fail until it is.`);
  const row = {
    id: p.id,
    name: p.name,
    baseUrl: p.base_url,
    apiKeyEnc: key ? encrypt(cfg.appSecret, key) : null,
    status: p.status,
    dataPolicy: p.data_policy,
    datacenter: p.datacenters,
    teeKind: p.tee?.kind ?? null,
    attestationUrl: p.tee?.attestation_url ?? null,
    payoutAddress: p.payout_address?.toLowerCase() ?? null,
    payoutMode: p.payout_address ? "usdg" : "invoice",
    timeoutMs: p.timeout_ms ?? null,
    headers: p.headers ?? null,
    staticModels: p.models ? p.models.map((m) => ({ ...m, anyroute: m.slug ? { slug: m.slug } : undefined })) : null,
    shadowUntil: p.status === "shadow" ? new Date(Date.now() + cfg.canaries.shadowDays * 86_400_000) : null,
  };
  await db.insert(providers).values(row).onConflictDoUpdate({ target: providers.id, set: { ...row, updatedAt: new Date() } });
  console.log(`✓ ${p.id} (${p.status})`);
}
await close();
// Import catalogs through a short-lived app instance (runs provider-registry once).
const { createApp } = await import("../src/app.ts");
const app = await createApp({ startJobs: false });
const r = await app.ctx.jobs.run("provider-registry");
for (const [id, res] of Object.entries(r as Record<string, { models?: number; errors?: string[]; error?: string }>))
  console.log(`  ${id}: ${res.error ? "ERROR " + res.error : `${res.models} models${res.errors?.length ? `, ${res.errors.length} invalid` : ""}`}`);
await app.close();
