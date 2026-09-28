// Operator maintenance command. Never print plaintext headers; run before release and rotate
// any credentials formerly stored in headers if the old public provider endpoint was exposed.
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { providers } from "../src/db/schema.ts";
import { sealProviderHeaders } from "../src/providers/headers.ts";
const cfg = loadConfig();
const handle = await openDatabase(cfg.databaseUrl, { migrate: false });
let count = 0;
try {
  await handle.db.transaction(async (tx) => {
    const rows = await tx.select().from(providers).for("update");
    for (const row of rows) {
      const headers = row.headers as Record<string, string> | null;
      if (!headers || typeof headers.encrypted_v1 === "string") continue;
      await tx.update(providers).set({ headers: sealProviderHeaders(cfg.appSecret, headers) }).where(eq(providers.id, row.id));
      count++;
    }
  });
  console.log(`Encrypted headers for ${count} providers.`);
} finally { await handle.close(); }
