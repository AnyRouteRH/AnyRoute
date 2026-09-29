// Dedicated deployment phase. A session advisory lock serializes all migration runners.
// After the schema migrations it enforces encrypted provider headers: with no plaintext rows it
// needs only DATABASE_URL; plaintext rows fail the job unless APP_SECRET is supplied, in which case
// they are encrypted and re-checked. Output names provider ids and counts only.
import postgres from "postgres";
import { openDatabase } from "../src/db/client.ts";
import { enforceEncryptedProviderHeaders } from "../src/providers/headers.ts";
const url = process.env.DATABASE_URL;
if (!url || !/^postgres(?:ql)?:/.test(url)) throw new Error("Migration job requires DATABASE_URL for PostgreSQL.");
const client = postgres(url, { max: 1, onnotice: () => {} });
const connection = await client.reserve();
try {
  await connection`select pg_advisory_lock(4663, 1)`;
  const handle = await openDatabase(url);
  try {
    const headers = await enforceEncryptedProviderHeaders(handle.db, process.env.APP_SECRET || undefined);
    console.log(
      headers.converted.length
        ? `Provider headers: converted ${headers.converted.length} legacy plaintext row(s) (${headers.converted.join(", ")}); rotate any credentials they held.`
        : `Provider headers: ${headers.checked} provider(s) checked, none stored in plaintext.`,
    );
  } finally {
    await handle.close();
  }
  console.log("Migrations completed successfully.");
} catch (error) {
  console.error(`Migration job failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await connection`select pg_advisory_unlock(4663, 1)`;
  connection.release(); await client.end();
}
