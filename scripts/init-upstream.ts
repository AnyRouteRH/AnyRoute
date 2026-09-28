// One-shot provider provisioning, without API, workers, chain keys or schema privileges.
import { and, eq, inArray, sql } from "drizzle-orm";
import { openDatabase } from "../src/db/client.ts";
import { offers, providers } from "../src/db/schema.ts";
import { decrypt, encrypt } from "../src/lib/util.ts";
import { boundedJson, providerFetch } from "../src/providers/network.ts";
import { fetchProviderModels, slugFor, syncProvider } from "../src/services/registry.ts";

async function main() {
  const key = process.env.UPSTREAM_API_KEY;
  const secret = process.env.APP_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  if (!key || !secret || secret.length < 32 || !databaseUrl?.startsWith("postgres"))
    throw new Error("UPSTREAM_API_KEY, APP_SECRET (32+ characters), and PostgreSQL DATABASE_URL are required.");
  const cfg = { appSecret: secret, production: true };
  const spec = {
    id: "upstream", name: "upstream", baseUrl: "https://upstream.example/v1", status: "live" as const,
    apiKeyEnc: encrypt(secret, key), headers: null, staticModels: null,
    dataPolicy: { training: true, retains_prompts: true, zdr: false },
    datacenter: [], payoutMode: "invoice" as const,
  };
  const catalogue = await fetchProviderModels({ cfg }, spec);
  if (!catalogue.ok.length) throw new Error("upstream returned no routable models.");
  if (process.env.UPSTREAM_SMOKE_TEST === "true") {
    // Deliberately small paid request; never prints credentials or upstream errors.
    const response = await providerFetch(`${spec.baseUrl}/chat/completions`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply only with OK." }], max_tokens: 8 }),
    }, { production: true });
    if (!response.ok) throw new Error(`upstream smoke returned HTTP ${response.status}.`);
    const result = await boundedJson(response) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (!result.choices?.[0]?.message?.content?.includes("OK") || !result.usage?.completion_tokens)
      throw new Error("upstream smoke did not return the expected completion and usage.");
    console.log(JSON.stringify({ event: "UPSTREAM_INFERENCE_PASS", model: "openai/gpt-4o-mini", prompt_tokens: result.usage.prompt_tokens, completion_tokens: result.usage.completion_tokens }));
  }
  const handle = await openDatabase(databaseUrl, { migrate: false });
  try {
    const role = await handle.db.execute(sql`select current_user as role`);
    if ((role as unknown as { role: string }[])[0]?.role !== "anyroute_runtime")
      throw new Error("Provider initialization requires the restricted anyroute_runtime role.");
    await handle.db.transaction(async (db) => {
      const [existing] = await db.select().from(providers).where(eq(providers.id, "upstream"));
      if (existing?.apiKeyEnc) decrypt(secret, existing.apiKeyEnc); // Do not silently change encryption keys.
      const [provider] = await db.insert(providers).values(spec).onConflictDoUpdate({
        target: providers.id, set: { ...spec, updatedAt: new Date() },
      }).returning();
      // Import the already validated catalogue atomically; future refreshes remain dynamic.
      await syncProvider({ db, cfg }, { ...provider, staticModels: catalogue.ok });
      await db.update(offers).set({ status: "live", updatedAt: new Date() }).where(and(eq(offers.providerId, "upstream"), inArray(offers.modelId, catalogue.ok.map(slugFor))));
      if (decrypt(secret, provider.apiKeyEnc!) !== key) throw new Error("Stored credential verification failed.");
    });
    console.log(JSON.stringify({ event: "UPSTREAM_INIT_PASS", provider: "upstream", models: catalogue.ok.length, rejected: catalogue.errors.length, encrypted_credential_verified: true, database_role: "anyroute_runtime" }));
  } finally { await handle.close(); }
}

try { await main(); }
catch { console.error("upstream initialization failed; credentials and upstream response withheld."); process.exitCode = 1; }
