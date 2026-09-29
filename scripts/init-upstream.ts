// One-shot provider provisioning, without API, workers, chain keys or schema privileges.
// Upstream identity comes only from the environment: UPSTREAM_API_KEY, UPSTREAM_BASE_URL, and optionally
// UPSTREAM_PROVIDER_ID / UPSTREAM_PROVIDER_NAME (the public label), UPSTREAM_RENAME_FROM (an earlier provider
// id whose rows move to the new id in the same transaction) and UPSTREAM_SMOKE_TEST / UPSTREAM_SMOKE_MODEL.
import { and, eq, inArray, sql } from "drizzle-orm";
import { openDatabase } from "../src/db/client.ts";
import { offers, providers } from "../src/db/schema.ts";
import { decrypt, encrypt } from "../src/lib/util.ts";
import { boundedJson, providerFetch } from "../src/providers/network.ts";
import { fetchProviderModels, slugFor, syncProvider } from "../src/services/registry.ts";

// Tables that carry a provider id (text columns, no foreign keys).
const PROVIDER_ID_TABLES = ["offers", "generations", "health", "canaries", "attestations", "byok_keys", "settlements", "payouts", "slashes"] as const;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function main() {
  const key = process.env.UPSTREAM_API_KEY;
  const baseUrl = process.env.UPSTREAM_BASE_URL;
  const id = process.env.UPSTREAM_PROVIDER_ID || "relay";
  const name = process.env.UPSTREAM_PROVIDER_NAME || "Anyroute Relay";
  const renameFrom = process.env.UPSTREAM_RENAME_FROM || "";
  const secret = process.env.APP_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  if (!key || !baseUrl?.startsWith("https://") || !secret || secret.length < 32 || !databaseUrl?.startsWith("postgres"))
    throw new Error("UPSTREAM_API_KEY, an https UPSTREAM_BASE_URL, APP_SECRET (32+ characters), and PostgreSQL DATABASE_URL are required.");
  if (!ID_RE.test(id) || (renameFrom && !ID_RE.test(renameFrom))) throw new Error("Provider ids must be lowercase letters, digits and hyphens.");
  const cfg = { appSecret: secret, production: true };
  const spec = {
    id, name, baseUrl, status: "live" as const,
    apiKeyEnc: encrypt(secret, key), headers: null, staticModels: null,
    dataPolicy: { training: true, retains_prompts: true, zdr: false },
    datacenter: [], payoutMode: "invoice" as const,
  };
  const catalogue = await fetchProviderModels({ cfg }, spec);
  if (!catalogue.ok.length) throw new Error("The upstream returned no routable models.");
  if (process.env.UPSTREAM_SMOKE_TEST === "true") {
    // Deliberately small paid request; never prints credentials or upstream errors.
    const model = process.env.UPSTREAM_SMOKE_MODEL || "openai/gpt-4o-mini";
    const response = await providerFetch(`${spec.baseUrl}/chat/completions`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply only with OK." }], max_tokens: 8 }),
    }, { production: true });
    if (!response.ok) throw new Error(`Upstream smoke returned HTTP ${response.status}.`);
    const result = await boundedJson(response) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (!result.choices?.[0]?.message?.content?.includes("OK") || !result.usage?.completion_tokens)
      throw new Error("Upstream smoke did not return the expected completion and usage.");
    console.log(JSON.stringify({ event: "UPSTREAM_INFERENCE_PASS", model, prompt_tokens: result.usage.prompt_tokens, completion_tokens: result.usage.completion_tokens }));
  }
  const handle = await openDatabase(databaseUrl, { migrate: false });
  try {
    const role = await handle.db.execute(sql`select current_user as role`);
    if ((role as unknown as { role: string }[])[0]?.role !== "anyroute_runtime")
      throw new Error("Provider initialization requires the restricted anyroute_runtime role.");
    let moved = 0;
    await handle.db.transaction(async (db) => {
      if (renameFrom && renameFrom !== id) {
        const [old] = await db.select().from(providers).where(eq(providers.id, renameFrom));
        const [taken] = await db.select().from(providers).where(eq(providers.id, id));
        if (old && taken) throw new Error("Both the earlier and the new provider id exist; resolve by hand.");
        if (old) {
          if (old.apiKeyEnc) decrypt(secret, old.apiKeyEnc); // Do not silently change encryption keys.
          await db.update(providers).set({ id, name, updatedAt: new Date() }).where(eq(providers.id, renameFrom));
          for (const table of PROVIDER_ID_TABLES)
            moved += Number((await db.execute(sql`update ${sql.identifier(table)} set provider_id = ${id} where provider_id = ${renameFrom}`) as unknown as { count?: number }).count ?? 0);
        }
      }
      const [existing] = await db.select().from(providers).where(eq(providers.id, id));
      if (existing?.apiKeyEnc) decrypt(secret, existing.apiKeyEnc); // Do not silently change encryption keys.
      const [provider] = await db.insert(providers).values(spec).onConflictDoUpdate({
        target: providers.id, set: { ...spec, updatedAt: new Date() },
      }).returning();
      // Import the already validated catalogue atomically; future refreshes remain dynamic.
      await syncProvider({ db, cfg }, { ...provider, staticModels: catalogue.ok });
      await db.update(offers).set({ status: "live", updatedAt: new Date() }).where(and(eq(offers.providerId, id), inArray(offers.modelId, catalogue.ok.map(slugFor))));
      if (decrypt(secret, provider.apiKeyEnc!) !== key) throw new Error("Stored credential verification failed.");
    });
    console.log(JSON.stringify({ event: "UPSTREAM_INIT_PASS", provider: id, renamed_rows: moved, models: catalogue.ok.length, rejected: catalogue.errors.length, encrypted_credential_verified: true, database_role: "anyroute_runtime" }));
  } finally { await handle.close(); }
}

try { await main(); }
catch { console.error("Upstream initialization failed; credentials and upstream response withheld."); process.exitCode = 1; }
