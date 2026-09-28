// Credits one API-issued fixture key using the application's ledger path.
// Never use this helper against a non-disposable database.
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { deriveKey } from "../src/chain/keys.ts";
import { accountIdFor } from "../src/api/auth.ts";
import { creditAccount } from "../src/ledger/ledger.ts";

const secret = process.argv[2];
if (process.env.TOPOLOGY_SMOKE_ACK !== "disposable-docker-host") throw new Error("This fixture helper is restricted to the disposable topology smoke.");
if (!secret?.startsWith("sk-ar-v1-")) throw new Error("Supply the newly created fixture key.");
const cfg = loadConfig();
if (!cfg.production) throw new Error("The topology fixture must keep production configuration enabled.");
const handle = await openDatabase(cfg.databaseUrl, { migrate: false });
try {
  const derived = deriveKey(secret);
  const accountId = accountIdFor(derived.chainKeyHash);
  await creditAccount(handle.db, {
    accountId,
    amount: 10_000_000_000_000n,
    kind: "credit",
    ref: `topology-fixture:${derived.keyHash}`,
    keyHash: derived.keyHash,
    description: "Disposable production-topology fixture",
  });
  process.stdout.write(JSON.stringify({ account_id: accountId, key_hash: derived.keyHash }));
} finally {
  await handle.close();
}
