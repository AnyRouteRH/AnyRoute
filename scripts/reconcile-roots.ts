// Read-only spent-root reconciliation (contract mode). Run it before approving a spent root and
// whenever the root_completeness readiness check fails:
//   DATABASE_URL=postgres://... bun scripts/reconcile-roots.ts [--grace-hours <h>]
// Checks that every funded key hash (indexed Credits Deposited/Credited events) is in the latest
// spent root, that no leaf exceeds its key's deposits minus withdrawals, that the root total is
// max(sum of leaves, previous total), that the stored leaves hash to the stored root, and that every
// indexed funding event matches exactly one ledger credit. Exits 1 on any failure.
import { openDatabase } from "../src/db/client.ts";
import { ROOT_REVIEW_SLA_MS } from "../src/services/readiness.ts";
import { reconcileSpentRoots } from "../src/services/root-completeness.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const graceIndex = process.argv.indexOf("--grace-hours");
const settlementIntervalMs = Number(process.env.SETTLEMENT_INTERVAL_MS ?? 3_600_000);
const graceMs = graceIndex >= 0 ? Number(process.argv[graceIndex + 1]) * 3_600_000 : ROOT_REVIEW_SLA_MS + 2 * settlementIntervalMs;
if (!(graceMs >= 0)) throw new Error("--grace-hours must be a non-negative number.");

const handle = await openDatabase(url, { migrate: false });
try {
  const result = await reconcileSpentRoots(handle.db, { graceMs, verifyMerkle: true });
  console.log(JSON.stringify({ ...result, grace_hours: graceMs / 3_600_000 }, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  await handle.close();
}
