// Dedicated deployment phase. A session advisory lock serializes all migration runners.
import postgres from "postgres";
import { openDatabase } from "../src/db/client.ts";
const url = process.env.DATABASE_URL;
if (!url || !/^postgres(?:ql)?:/.test(url)) throw new Error("Migration job requires DATABASE_URL for PostgreSQL.");
const client = postgres(url, { max: 1, onnotice: () => {} });
const connection = await client.reserve();
try {
  await connection`select pg_advisory_lock(4663, 1)`;
  const handle = await openDatabase(url);
  await handle.close();
  console.log("Migrations completed successfully.");
} finally {
  await connection`select pg_advisory_unlock(4663, 1)`;
  connection.release(); await client.end();
}
