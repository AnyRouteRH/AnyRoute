import { webhookTables } from "./webhooks.ts"; // V86: retained webhook configuration and attempt metadata.
import { profileTables } from "./tables/agent-profiles.ts";
import { describeSealed } from "./sealed.ts";
import { agreementTables } from "./tables/agreements.ts";
import { networkPayoutTables } from "./tables/network-payouts.ts";
import { hostBondTables } from "./tables/host-bonds.ts";
import { describeAutonomy } from "./autonomy.ts";
import { agentLedgerTables } from "./tables/agent-ledger.ts";
import { agentTables } from "./tables/agents.ts";
import { approvalTables } from "./tables/agent-approvals.ts";
import { sanctionsTables } from "./tables/sanctions.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { columnFlags, informationSchemaType } from "./rules.ts";
import { schemaTables, type SchemaTable } from "./schema.ts";
import { EXTERNAL } from "./outside.ts";
import { billingTables } from "./tables/billing.ts";
import { chainTables } from "./tables/chain.ts";
import { characterTables } from "./tables/characters.ts";
import { keyTables } from "./tables/keys.ts";
import { networkTables } from "./tables/network.ts";
import { operationTables } from "./tables/operations.ts";
import { providerTables } from "./tables/providers.ts";
import { receiptTables } from "./tables/receipts.ts";
import { requestTables } from "./tables/request.ts";
import { skillTables } from "./tables/skills.ts";
import { CATEGORIES, CATEGORY_INFO, type AboutRequest, type ColumnDoc, type ExternalDoc, type Review, type TableDoc } from "./types.ts";

// The data inventory: a description of every table and column in src/db/schema.ts, of the Redis keys the router writes, of what
// its logger records and of every place a request's body or a caller's address is read. The descriptions live next to the code
// (this folder); the tests fail when the schema and the descriptions disagree; and the "What we keep" page and
// /keep/inventory.json are generated from `buildInventory()`. Its SHA-256 is appended to the transparency log
// (kind data_inventory) whenever a new version is deployed.

export const INVENTORY_FORMAT = "anyroute.data-inventory/1";

export const TABLE_DOCS: Record<string, TableDoc> = { ...webhookTables, ...requestTables, ...billingTables, ...receiptTables, ...keyTables, ...providerTables, ...chainTables, ...operationTables, ...characterTables, ...skillTables, ...networkTables, ...networkPayoutTables, ...sanctionsTables, ...agentTables, ...approvalTables, ...hostBondTables, ...agentLedgerTables, ...profileTables, ...agreementTables };
describeAutonomy(TABLE_DOCS);
describeSealed(TABLE_DOCS);
export { EXTERNAL };

// ---- consistency -----------------------------------------------------------------------------------------------------

const asColumn = (d: ColumnDoc) => (typeof d === "string" ? { purpose: d } : d);
const MIN_REVIEW = 40;
const MIN_PURPOSE = 8;

/**
 * Everything wrong between the schema and the descriptions, as sentences. An empty list means every table and column has a
 * description, no description names something that does not exist, and every column the rules flag has a review that lists
 * exactly the flags raised (and no review is written for a column that raises none).
 */
export function checkInventory(schema: SchemaTable[] = schemaTables(), docs: Record<string, TableDoc> = TABLE_DOCS): string[] {
  const problems: string[] = [];
  const byName = new Map(schema.map((t) => [t.name, t]));
  for (const t of schema) if (!docs[t.name]) problems.push(`table ${t.name} has no inventory entry`);
  for (const name of Object.keys(docs)) if (!byName.has(name)) problems.push(`the inventory describes table ${name}, which is not in the schema`);
  for (const t of schema) {
    const doc = docs[t.name];
    if (!doc) continue;
    if (!CATEGORIES.includes(doc.category)) problems.push(`table ${t.name}: unknown category ${doc.category}`);
    if (doc.purpose.trim().length < MIN_PURPOSE) problems.push(`table ${t.name}: the purpose is empty`);
    if (doc.retention.trim().length < MIN_PURPOSE) problems.push(`table ${t.name}: the retention note is empty`);
    const cols = new Set(t.columns.map((c) => c.name));
    for (const c of t.columns) {
      const raw = doc.columns[c.name];
      if (raw === undefined) {
        problems.push(`column ${t.name}.${c.name} has no inventory entry`);
        continue;
      }
      const d = asColumn(raw);
      if (d.purpose.trim().length < MIN_PURPOSE) problems.push(`column ${t.name}.${c.name}: the purpose is empty`);
      const flags = columnFlags(c.name, c.type);
      if (flags.length && !d.review) problems.push(`column ${t.name}.${c.name} (${c.type}) looks like request content or a network address (${flags.join(", ")}) and has no reviewed justification`);
      if (d.review) {
        if (!flags.length) problems.push(`column ${t.name}.${c.name} has a review but raises no flag; remove the review`);
        else if ([...d.review.covers].sort().join() !== flags.join()) problems.push(`column ${t.name}.${c.name}: the review covers [${[...d.review.covers].sort().join(", ")}] but the rules flag [${flags.join(", ")}]`);
        if (d.review.why.trim().length < MIN_REVIEW) problems.push(`column ${t.name}.${c.name}: the review needs a real justification`);
      }
    }
    for (const name of Object.keys(doc.columns)) if (!cols.has(name)) problems.push(`the inventory describes column ${t.name}.${name}, which is not in the schema`);
  }
  return problems;
}

/** A row of information_schema.columns for the public schema. */
export type DatabaseColumn = { table_name: string; column_name: string; data_type: string; udt_name: string };

/**
 * The same checks against the columns of a real database (migrations applied), so a column that exists only in a migration, or a
 * migration that drifts from schema.ts, cannot slip past: every column needs its entry, every entry needs its column, every
 * column the rules flag needs its review, and no reviewed column may be a request-text or network-address holder unless the
 * verdict says so openly (the summary then stops claiming otherwise).
 */
export function checkDatabaseColumns(rows: DatabaseColumn[], docs: Record<string, TableDoc> = TABLE_DOCS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = `${r.table_name}.${r.column_name}`;
    seen.add(id);
    const raw = docs[r.table_name]?.columns[r.column_name];
    if (raw === undefined) {
      problems.push(`the database has ${id}, which has no inventory entry`);
      continue;
    }
    const type = informationSchemaType(r.data_type, r.udt_name);
    const flags = columnFlags(r.column_name, type);
    const review = asColumn(raw).review;
    if (flags.length && !review) problems.push(`${id} (${type}) looks like request content or a network address (${flags.join(", ")}) and has no reviewed justification`);
    else if (review && [...review.covers].sort().join() !== flags.join()) problems.push(`${id}: the review covers [${[...review.covers].sort().join(", ")}] but the rules flag [${flags.join(", ")}] for the column as the database has it`);
  }
  for (const [table, doc] of Object.entries(docs)) for (const column of Object.keys(doc.columns)) if (!seen.has(`${table}.${column}`)) problems.push(`the inventory describes ${table}.${column}, which the database does not have`);
  return problems;
}

/** Columns whose review says they hold request or answer text, or a caller's network address. Empty today. */
export function columnsHoldingRequestData(docs: Record<string, TableDoc> = TABLE_DOCS): string[] {
  const out: string[] = [];
  for (const [table, doc] of Object.entries(docs))
    for (const [column, raw] of Object.entries(doc.columns)) {
      const v = asColumn(raw).review?.verdict;
      if (v === "holds-request-text" || v === "network-address") out.push(`${table}.${column}`);
    }
  return out;
}

// ---- the document ----------------------------------------------------------------------------------------------------

type ColumnOut = { name: string; type: string; nullable: boolean; purpose: string; about_request: AboutRequest; retention?: string; flags?: string[]; review?: Review };
type TableOut = { name: string; category: string; purpose: string; about_request: AboutRequest; retention: string; notes?: string[]; columns: ColumnOut[] };

export type Summary = {
  headline: string;
  facts: string[];
  caveats: { title: string; text: string }[];
  reads: string;
  counts: { tables: number; columns: number; reviewed_columns: number; hash_columns: number };
};

export type InventoryDocument = {
  format: typeof INVENTORY_FORMAT;
  summary: Summary;
  categories: { id: string; label: string; summary: string }[];
  postgres: { tables: TableOut[] };
  outside_postgres: unknown;
};

const camelToSnake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
/** Public JSON uses snake_case; the inventory source uses camelCase. Only fixed field names are converted (there are no maps). */
function snake(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snake);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [camelToSnake(k), snake(x)]));
  return v;
}

const list = (items: string[]) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`);
const n = (x: number) => x.toLocaleString("en-US");

/**
 * The sentences at the top of the page, written from the data. "No table holds prompt or answer text" is said only when no
 * column has the verdict holds-request-text; "no table holds a network address" only when no column has the verdict
 * network-address and none has a network type. Everything that keeps something is listed as a caveat in exact terms.
 */
export function summarize(tables: TableOut[], ext: ExternalDoc): Summary {
  const cols = tables.flatMap((t) => t.columns.map((c) => ({ table: t, col: c, id: `${t.name}.${c.name}` })));
  const verdict = (v: string) => cols.filter((c) => c.col.review?.verdict === v);
  const holdsText = verdict("holds-request-text");
  const holdsAddress = [...verdict("network-address"), ...cols.filter((c) => /^(inet|cidr|macaddr8?)$/.test(c.col.type))];
  const fragments = verdict("may-hold-fragment");
  const headers = verdict("request-header");
  const settings = cols.filter((c) => c.col.review?.verdict === "config" && (c.table.category === "keys" || c.table.category === "operations") && !c.col.flags?.includes("name:network"));
  const hashes = verdict("digest-only");
  const sealed = ext.redis.families.filter((f) => f.requestText === "answer-text");
  const addressKeys = ext.redis.families.filter((f) => f.holds === "address");
  const longest = Math.max(0, ...addressKeys.map((f) => (f.windowSeconds ?? 0) + 1));
  const shortest = Math.min(...addressKeys.map((f) => (f.windowSeconds ?? 0) + 1));
  const generations = tables.find((t) => t.name === "generations");

  const headline = holdsText.length
    ? `Some tables hold request or answer text: ${list(holdsText.map((c) => c.id))}.`
    : "We store no prompt or answer text in our database.";

  const facts: string[] = [];
  facts.push(
    `Every one of the ${n(tables.length)} tables and ${n(cols.length)} columns in the database schema is described on this page, and the build fails if a table or column is added without one.`,
  );
  if (!holdsText.length && generations)
    facts.push(
      `A call leaves a row of counts, cost and timing plus two SHA-256 hashes (${hashes.filter((c) => c.table.name === "generations").map((c) => c.col.name).join(" and ")}) so a receipt can be checked against a request you hold. A hash cannot be turned back into the text.`,
    );
  if (!holdsAddress.length)
    facts.push(
      `No table has a column for a network address, and no line the code writes to its log records one. ${addressKeys.length ? `Calls without an API key are rate-limited by the caller's address, which appears only inside a Redis key that expires ${shortest === longest ? `${n(longest)} seconds` : `between ${n(shortest)} seconds and ${n(longest)} seconds`} after the counting window begins. Over Tor no address is used at all.` : ""}`.trim(),
    );
  else facts.push(`Some columns hold a network address: ${list(holdsAddress.map((c) => c.id))}.`);

  const caveats: { title: string; text: string }[] = [];
  for (const f of sealed)
    caveats.push({
      title: "The response cache keeps answers when you ask it to",
      text: `A request that turns the response cache on has its answer kept, sealed with AES-256-GCM, in Redis and in the router's memory. ${f.ttl} Requests that do not ask for caching leave nothing here, and a call paid with a blind token, a call on the attested lane or with any disclosure ceiling, a restricted model variant and a streamed answer are never cached. A semantic cache also keeps a 1,024-number hashed word vector of the prompt in memory.`,
    });
  for (const f of ext.redis.families.filter((x) => x.requestText === "request-and-answer-text"))
    caveats.push({
      title: "The Batch API keeps a batch's requests and answers until its results expire",
      text: `A batch sent to POST /api/v1/batches has its requests and answers kept, sealed with AES-256-GCM, in Redis (or the router's memory without Redis), never in the database. ${f.ttl} Calls that are not part of a batch leave nothing here.`,
    });
  if (fragments.length)
    caveats.push({
      title: "A failed provider attempt can keep a short piece of the provider's own error message",
      text: `${list(fragments.map((c) => c.id))}: up to 200 characters of the message a provider sent back when an attempt failed, with URLs, keys, emails and long hex removed. The text is the provider's, not ours; a provider could quote part of a rejected request in it.`,
    });
  if (headers.length)
    caveats.push({
      title: "Two request headers are kept as you wrote them",
      text: `${list(headers.map((c) => c.id))}: the HTTP-Referer and X-Title headers of a chat call, cut to 500 and 200 characters, so apps can be ranked. Leave the headers out and nothing is kept. They are not recorded on the unlinkable lane.`,
    });
  if (settings.length)
    caveats.push({
      title: "Settings you type are stored as you typed them",
      text: `${list(settings.map((c) => c.id))} hold configuration you write: descriptions, routing and guardrail settings, the system prompts and tool definitions of your presets, the character cards you publish, session labels. The API checks their shape and size, but it cannot know what you choose to write in a description or a label.`,
    });

  if (tables.some((t) => t.name === "character_memory"))
    caveats.push({
      title: "Character memory is kept only as ciphertext, with a vector if you opt in",
      text: "Memories you keep for a character are sealed on your device under a key the router never receives; the database holds the ciphertext. If you opt in to memory search, it also holds a vector your client computed from each memory, which cannot be turned back into the text but can reveal what it is about.",
    });

  return {
    headline,
    facts,
    caveats,
    reads:
      "This page is about what is kept. It is not a claim that nobody can read a request while it is in flight: on ordinary chat routes on every lane the router reads the text of a request in memory, and the provider reads it too under its own policy. The dedicated, off-by-default E2EE adapter forwards encrypted content without decryption; the gateway enclave restores it. Clear routing and billing metadata remains visible.",
    counts: { tables: tables.length, columns: cols.length, reviewed_columns: cols.filter((c) => c.col.review).length, hash_columns: hashes.length },
  };
}

/**
 * The inventory as a document. Throws when the schema and the descriptions disagree, so a router or a build never publishes
 * a description that is stale.
 */
export function buildInventory(schema: SchemaTable[] = schemaTables(), docs: Record<string, TableDoc> = TABLE_DOCS, ext: ExternalDoc = EXTERNAL): InventoryDocument {
  const problems = checkInventory(schema, docs);
  if (problems.length) throw new Error(`The data inventory does not match the schema:\n- ${problems.join("\n- ")}`);
  const order = (c: string) => CATEGORIES.indexOf(c as (typeof CATEGORIES)[number]);
  const tables: TableOut[] = schema
    .map((t): TableOut => {
      const d = docs[t.name]!;
      return {
        name: t.name,
        category: d.category,
        purpose: d.purpose,
        about_request: d.request,
        retention: d.retention,
        ...(d.notes?.length ? { notes: d.notes } : {}),
        columns: t.columns.map((c): ColumnOut => {
          const cd = asColumn(d.columns[c.name]!);
          const flags = columnFlags(c.name, c.type);
          return {
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            purpose: cd.purpose,
            about_request: cd.request ?? d.request,
            ...(cd.retention ? { retention: cd.retention } : {}),
            ...(flags.length ? { flags } : {}),
            ...(cd.review ? { review: { covers: [...cd.review.covers].sort(), verdict: cd.review.verdict, why: cd.review.why } } : {}),
          };
        }),
      };
    })
    .sort((a, b) => order(a.category) - order(b.category) || (a.name < b.name ? -1 : 1));
  return {
    format: INVENTORY_FORMAT,
    summary: summarize(tables, ext),
    categories: CATEGORIES.map((id) => ({ id, ...CATEGORY_INFO[id] })),
    postgres: { tables },
    outside_postgres: snake(ext),
  };
}

/** The exact bytes served at /keep/inventory.json and hashed for the transparency log: canonical JSON, keys sorted, no whitespace. */
export const inventoryJson = (doc: InventoryDocument = buildInventory()) => canonicalJson(doc);

/** SHA-256 (hex) of the inventory JSON. */
export const inventoryDigest = (doc?: InventoryDocument) => sha256(inventoryJson(doc));

let current: { sha256: string; format: string; tables: number; columns: number } | null = null;

/** The digest and size of the inventory this build has, computed once: what the transparency log records for it. */
export function currentInventory() {
  if (!current) {
    const doc = buildInventory();
    current = { sha256: inventoryDigest(doc), format: doc.format, tables: doc.summary.counts.tables, columns: doc.summary.counts.columns };
  }
  return current;
}
