// Disposable fixture used by recovery-drill.sh; never accepts a production database name.
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client.ts";
import { kv } from "../src/db/schema.ts";
import { ensureAccount, post, reserve, balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { sealProviderHeaders, openProviderHeaders } from "../src/providers/headers.ts";

const dbName = process.env.PGDATABASE ?? "";
if (!/^anyroute_drill_[0-9]+_[0-9]+_(source|restore)$/.test(dbName)) throw new Error("Disposable drill database required");
const mode = process.argv[2];
if (!["seed", "verify"].includes(mode ?? "")) throw new Error("Use seed or verify");
const url = new URL(`postgres://${process.env.PGHOST ?? "127.0.0.1"}:${process.env.PGPORT ?? "5432"}/${dbName}`);
url.username = process.env.PGUSER ?? "postgres";
url.password = process.env.PGPASSWORD ?? "";
const secret = process.env.DRILL_APP_SECRET;
if (!secret) throw new Error("A disposable drill encryption secret is required");
const h = await openDatabase(url.toString(), { migrate: mode === "seed" });
try {
  if (mode === "seed") {
    await ensureAccount(h.db, "drill-account");
    await post(h.db, { accountId: "drill-account", amount: 10_000_000_000_000n, kind: "credit", ref: "drill-credit" });
    await reserve(h.db, { id: "drill-hold", accountId: "drill-account", amount: 2_000_000_000_000n, ttlMs: 86400000 });
    await h.db.insert(kv).values({ key: "drill-encrypted-header", value: sealProviderHeaders(secret, { authorization: "fixture-only-provider-value" }) });
  }
  const result = await verifyInvariants(h.db);
  const balance = await balanceOf(h.db, "drill-account");
  if (!result.ok || balance.balance !== 10_000_000_000_000n || balance.held !== 2_000_000_000_000n) throw new Error("Restored ledger/hold mismatch");
  const [row] = await h.db.select().from(kv).where(eq(kv.key, "drill-encrypted-header"));
  if (openProviderHeaders(secret, row?.value).authorization !== "fixture-only-provider-value") throw new Error("Restored credential cannot be decrypted");
  console.log(`Recovery fixture ${mode}: ledger, holds and encrypted provider data verified`);
} finally { await h.close(); }
