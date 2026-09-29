// Print the MeasurementRegistry.register() calldata the measurement keeper prepared (nothing is sent), or record
// the transaction an operator sent for one of them.
//
//   bun scripts/measurement-calldata.ts                    list prepared calldata as JSON
//   bun scripts/measurement-calldata.ts --record <id> <txHash>
//
// Needs DATABASE_URL (an already-migrated database). The registry only accepts register() from its attestor
// address, so the transaction is sent by whoever holds that role; a row becomes "registered" only when the router
// later reads the registry (MEASUREMENT_REGISTRY_ADDRESS) and it reports the measurement attested.
import { and, eq, isNotNull } from "drizzle-orm";
import { openDatabase } from "../src/db/client.ts";
import { measurements } from "../src/db/schema.ts";
import type { Ctx } from "../src/context.ts";
import { recordSubmission } from "../src/services/measurements.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const args = process.argv.slice(2);
const h = await openDatabase(url, { migrate: false });
try {
  if (args[0] === "--record") {
    const id = Number(args[1]);
    if (!Number.isInteger(id) || !args[2]) throw new Error("usage: --record <id> <txHash>");
    await recordSubmission({ db: h.db } as Ctx, id, args[2]);
    console.log(JSON.stringify({ recorded: id }));
  } else {
    const rows = await h.db.select().from(measurements).where(and(eq(measurements.status, "ready"), isNotNull(measurements.calldata)));
    console.log(
      JSON.stringify(
        rows.map((r) => ({ id: r.id, provider: r.providerId, image_digest: r.imageDigest, model_digest: r.modelDigest, rekor_entry: r.rekorEntry, to: r.calldataTarget, submitted_tx: r.txHash, calldata: r.calldata })),
        null,
        2,
      ),
    );
  }
} finally {
  await h.close();
}
