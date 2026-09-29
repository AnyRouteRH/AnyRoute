// Operator maintenance command: the provider-header phase of the migration job (scripts/migrate.ts),
// which runs it on every deployment. Idempotent; prints provider ids and counts, never headers.
// Rotate every credential that was stored in plaintext headers under an earlier release.
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { enforceEncryptedProviderHeaders } from "../src/providers/headers.ts";
const cfg = loadConfig();
const handle = await openDatabase(cfg.databaseUrl, { migrate: false });
try {
  const r = await enforceEncryptedProviderHeaders(handle.db, cfg.appSecret);
  console.log(`Encrypted headers for ${r.converted.length} of ${r.checked} providers${r.converted.length ? ` (${r.converted.join(", ")})` : ""}.`);
} finally { await handle.close(); }
