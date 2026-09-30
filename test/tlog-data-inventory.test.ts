import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { tlogEntries } from "../src/db/schema.ts";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { currentInventory, inventoryDigest, INVENTORY_FORMAT } from "../src/privacy/inventory.ts";
import { dataInventoryEntry, ENTRY_KINDS, entryText, isEntryKind } from "../src/tlog/entries.ts";
import { formatSignerKey, noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { startRouter, type Harness } from "./helpers.ts";
import { ROOT } from "./support/source-scan.ts";

// The hash of the data inventory as a transparency-log entry (kind data_inventory): appended when a router with a new inventory
// starts, never for a router with the feature off, and equal to the SHA-256 of the file the "What we keep" page publishes.

setDefaultTimeout(60_000);

const TLOG = { TLOG_ENABLED: "true", TLOG_ORIGIN: "inventory.test/tlog", TLOG_WITNESS_QUORUM: "1", TLOG_COSIGN_RPM: "1000" };
const lookup = (h: Harness, digest: string) => h.request(`/api/v1/tlog/lookup?kind=data_inventory&sha256=${digest}`);
const rows = (h: Harness) => h.ctx.db.select().from(tlogEntries).where(eq(tlogEntries.kind, "data_inventory"));

describe("entry kind", () => {
  test("data_inventory is a kind, and the entry is canonical JSON naming the inventory's digest, format and size", () => {
    expect(ENTRY_KINDS).toContain("data_inventory");
    expect(isEntryKind("data_inventory")).toBe(true);
    const digest = inventoryDigest();
    const e = dataInventoryEntry(currentInventory());
    expect(e).toMatchObject({ kind: "data_inventory", sha256: digest, subject: `inventory:${digest.slice(0, 16)}` });
    const text = entryText(e);
    expect(text).toBe(canonicalJson(JSON.parse(text)));
    expect(JSON.parse(text)).toEqual({
      v: 1,
      type: "anyroute.tlog.entry",
      kind: "data_inventory",
      sha256: digest,
      key: { format: INVENTORY_FORMAT, inventory_sha256: digest, tables: currentInventory().tables, columns: currentInventory().columns, path: "/keep/inventory.json" },
    });
  });

  test("the digest is that of the file the page publishes", () => {
    const file = readFileSync(join(ROOT, "web/app/keep/inventory.generated.json"), "utf8");
    expect(sha256(file)).toBe(currentInventory().sha256);
  });
});

describe("configuration", () => {
  test("it is off by default, needs the log, and changes nothing else", () => {
    expect(loadConfig({}).tlog.dataInventory).toBe(false);
    expect(loadConfig({ ...TLOG }).tlog.dataInventory).toBe(false);
    expect(loadConfig({ ...TLOG, TLOG_DATA_INVENTORY: "true" }).tlog.dataInventory).toBe(true);
    expect(() => loadConfig({ TLOG_DATA_INVENTORY: "true" })).toThrow("TLOG_DATA_INVENTORY needs TLOG_ENABLED");
  });
});

describe("production configuration", () => {
  const production = {
    ANYROUTE_ENV: "production",
    RUNTIME_ROLE: "api",
    AUTO_MIGRATE: "false",
    HOST: "0.0.0.0",
    APP_SECRET: "fixture-".repeat(6),
    ADMIN_TOKEN: "fixture-admin-".repeat(3),
    PUBLIC_BASE_URL: "https://router.example",
    DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test",
    REDIS_URL: "redis://:fixture-only-credential@localhost:6379",
    CREDITS_ADDRESS: "0x" + "1".repeat(40),
    CALLPAY_ADDRESS: "0x" + "1".repeat(40),
    PROVIDER_BOND_ADDRESS: "0x" + "1".repeat(40),
    RECEIPT_ANCHOR_ADDRESS: "0x" + "1".repeat(40),
    ROUTER_PRIVATE_KEY: "0x" + "2".repeat(64),
  };
  const witnesses = [1, 2].map((i) => noteSigner(`w${i}.example/w`, SIG_COSIGNATURE_V1, randomBytes(32)).verifierKey).join(",");
  const tlog = { TLOG_ENABLED: "true", TLOG_SIGNING_KEY: formatSignerKey("router.example/tlog", randomBytes(32)), TLOG_WITNESSES: witnesses };

  test("a production router starts with the data inventory logged, on the API and on the worker that runs the log job", () => {
    expect(loadConfig({ ...production, ...tlog, TLOG_DATA_INVENTORY: "true" }).tlog).toMatchObject({ enabled: true, dataInventory: true });
    const { ROUTER_PRIVATE_KEY: _r, ...worker } = production;
    expect(loadConfig({ ...worker, RUNTIME_ROLE: "worker", WORKER_JOBS: "tlog", ...tlog, TLOG_DATA_INVENTORY: "true" }).tlog.dataInventory).toBe(true);
    // Without the switch a production router is configured exactly as before.
    expect(loadConfig({ ...production, ...tlog }).tlog.dataInventory).toBe(false);
  });
});

describe("in the router, switched on", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { ...TLOG, TLOG_DATA_INVENTORY: "true" } });
    await h.ctx.tlog!.idle();
  });
  afterAll(async () => h.close());

  test("the inventory hash is in the log after start, with an inclusion proof under a signed checkpoint", async () => {
    const digest = inventoryDigest();
    const found = await lookup(h, digest);
    expect(found.status).toBe(200);
    const d = (await found.json()).data;
    expect(d).toMatchObject({ kind: "data_inventory", sha256: digest });
    expect(JSON.parse(d.entry).key.inventory_sha256).toBe(digest);

    const proof = (await (await h.request(`/api/v1/tlog/proof?kind=data_inventory&sha256=${digest}`)).json()).data;
    expect(proof.index).toBe(d.index);
    expect(proof.checkpoint.size).toBeGreaterThan(d.index);
    expect(Array.isArray(proof.inclusion)).toBe(true);
  });

  test("running the log again does not append it twice; a different inventory is a second entry and the first stays", async () => {
    const before = await rows(h);
    expect(before).toHaveLength(1);
    expect(await h.ctx.tlog!.sync()).toBe(0);
    expect((await h.ctx.tlog!.run()).added).toBe(0);
    expect(await rows(h)).toHaveLength(1);

    const next = dataInventoryEntry({ sha256: sha256("a later inventory"), format: INVENTORY_FORMAT, tables: 52, columns: 600 });
    expect(await h.ctx.tlog!.append([next])).toBe(1);
    const after = await rows(h);
    expect(after.map((r) => r.sha256).sort()).toEqual([inventoryDigest(), next.sha256].sort());
    expect((await lookup(h, inventoryDigest())).status).toBe(200);
  });

  test("the log describes the new kind", async () => {
    const d = (await (await h.request("/api/v1/tlog")).json()).data;
    expect(d.kinds).toContain("data_inventory");
  });
});

describe("in the router, switched off", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { ...TLOG } });
    await h.ctx.tlog!.idle();
  });
  afterAll(async () => h.close());

  test("nothing is appended for the inventory, and the log holds only what it held before", async () => {
    expect(await rows(h)).toHaveLength(0);
    expect((await lookup(h, inventoryDigest())).status).toBe(404);
    expect(await h.ctx.tlog!.sync()).toBe(0);
  });
});
