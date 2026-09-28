import { openDatabase } from "../src/db/client.ts";
import { verifyInvariants } from "../src/ledger/ledger.ts";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const h = await openDatabase(url, { migrate: false });
try {
  const result = await verifyInvariants(h.db);
  console.log(JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v));
  if (!result.ok) process.exitCode = 1;
} finally { await h.close(); }
