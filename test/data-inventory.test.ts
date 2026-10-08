import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../src/lib/util.ts";
import { buildInventory, checkInventory, columnsHoldingRequestData, EXTERNAL, INVENTORY_FORMAT, inventoryDigest, inventoryJson, summarize, TABLE_DOCS } from "../src/privacy/inventory.ts";
import { columnFlags, typeFamily } from "../src/privacy/rules.ts";
import { schemaTables, type SchemaTable } from "../src/privacy/schema.ts";
import type { ExternalDoc, TableDoc } from "../src/privacy/types.ts";
import { findCalls, literals, read, ROOT, sourceFiles } from "./support/source-scan.ts";

// The data inventory (src/privacy) describes everything the router stores. These tests keep it honest: the descriptions must match
// the schema exactly, every column that looks like request content or a network address must carry a reviewed justification, and
// the statements about Redis, the log and the readers of requests and addresses must match the source they describe.

// The inventory's own files quote source lines as evidence, so they are not scanned as source.
const files = sourceFiles().filter((f) => !f.startsWith("src/privacy/"));

describe("the inventory matches the schema", () => {
  test("every table and every column in src/db/schema.ts has an entry, and no entry describes something that is not there", () => {
    expect(checkInventory()).toEqual([]);
    const schema = schemaTables();
    expect(Object.keys(TABLE_DOCS).sort()).toEqual(schema.map((t) => t.name));
    for (const t of schema) expect(Object.keys(TABLE_DOCS[t.name].columns).sort()).toEqual(t.columns.map((c) => c.name).sort());
  });

  test("a new table, a new column or a dropped column makes the check fail", () => {
    const schema = schemaTables();
    const withTable: SchemaTable[] = [...schema, { name: "conversation_log", columns: [{ name: "id", type: "text", nullable: false }] }];
    expect(checkInventory(withTable).join("\n")).toContain("table conversation_log has no inventory entry");

    const withColumn = schema.map((t) => (t.name === "keys" ? { ...t, columns: [...t.columns, { name: "notes", type: "integer", nullable: true }] } : t));
    expect(checkInventory(withColumn)).toEqual(["column keys.notes has no inventory entry"]);

    const dropped = schema.map((t) => (t.name === "keys" ? { ...t, columns: t.columns.filter((c) => c.name !== "label") } : t));
    expect(checkInventory(dropped)).toEqual(["the inventory describes column keys.label, which is not in the schema"]);

    expect(checkInventory(schema.filter((t) => t.name !== "kv"))).toEqual(["the inventory describes table kv, which is not in the schema"]);
  });

  test("a description that is empty, or a category that does not exist, fails", () => {
    const schema = schemaTables();
    const docs = structuredClone(TABLE_DOCS) as Record<string, TableDoc>;
    docs.kv.columns.key = "";
    (docs.kv as { category: string }).category = "misc";
    const problems = checkInventory(schema, docs).join("\n");
    expect(problems).toContain("column kv.key: the purpose is empty");
    expect(problems).toContain("table kv: unknown category misc");
  });
});

describe("columns that look like request content or a network address", () => {
  test("the rules flag names and types that suggest request text or an address", () => {
    expect(columnFlags("prompt", "text")).toEqual(["name:content"]);
    expect(columnFlags("messages", "jsonb")).toEqual(["name:content", "type:json"]);
    expect(columnFlags("request_body", "text")).toEqual(["name:content"]);
    expect(columnFlags("completion_text", "text")).toEqual(["name:content"]);
    expect(columnFlags("ip", "text")).toEqual(["name:network"]);
    expect(columnFlags("client_ip", "inet")).toEqual(["name:network", "type:network"]);
    expect(columnFlags("last_seen", "inet")).toEqual(["type:network"]);
    expect(columnFlags("user_agent", "text")).toEqual(["name:network"]);
    expect(columnFlags("referer", "text")).toEqual(["name:network"]);
    expect(columnFlags("from_address", "text")).toEqual(["name:network"]);
    expect(columnFlags("blob", "bytea")).toEqual(["type:binary"]);
    expect(columnFlags("anything", "jsonb")).toEqual(["type:json"]);
  });

  test("numbers, flags and timestamps cannot hold a sentence, so a price named for a prompt is only a price", () => {
    expect(columnFlags("price_prompt", "bigint")).toEqual([]);
    expect(columnFlags("prompt_tokens", "integer")).toEqual([]);
    expect(columnFlags("tokens_in", "integer")).toEqual([]);
    expect(columnFlags("created_at", "timestamp with time zone")).toEqual([]);
    expect(typeFamily("numeric(78, 0)")).toBe("number");
    expect(typeFamily("text[]")).toBe("array");
  });

  test("every column the rules flag has a review that lists exactly those flags, and no review is unneeded", () => {
    const flagged: string[] = [];
    for (const t of schemaTables())
      for (const c of t.columns) {
        const flags = columnFlags(c.name, c.type);
        const raw = TABLE_DOCS[t.name].columns[c.name];
        const review = typeof raw === "string" ? undefined : raw.review;
        if (flags.length) {
          flagged.push(`${t.name}.${c.name}`);
          expect(review, `${t.name}.${c.name} needs a review`).toBeDefined();
          expect([...review!.covers].sort(), `${t.name}.${c.name}`).toEqual(flags);
          expect(review!.why.length, `${t.name}.${c.name}`).toBeGreaterThan(40);
        } else expect(review, `${t.name}.${c.name} has a review but raises no flag`).toBeUndefined();
      }
    expect(flagged.length).toBeGreaterThan(30);
  });

  test("a new column named prompt, body, ip or user_agent, or typed inet or jsonb, fails until it is reviewed", () => {
    const schema = schemaTables().map((t) =>
      t.name === "health"
        ? {
            ...t,
            columns: [
              ...t.columns,
              { name: "prompt", type: "text", nullable: true },
              { name: "body", type: "jsonb", nullable: true },
              { name: "ip", type: "inet", nullable: true },
              { name: "user_agent", type: "text", nullable: true },
            ],
          }
        : t,
    );
    const docs = structuredClone(TABLE_DOCS) as Record<string, TableDoc>;
    for (const name of ["prompt", "body", "ip", "user_agent"]) docs.health.columns[name] = "Something added without a review.";
    const problems = checkInventory(schema, docs);
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain("health.prompt (text) looks like request content or a network address (name:content) and has no reviewed justification");
    expect(problems.join("\n")).toContain("health.body (jsonb)");
    expect(problems.join("\n")).toContain("health.ip (inet)");
    expect(problems.join("\n")).toContain("health.user_agent (text)");
    // A review must list the flags the rules raise: covering only part of them does not pass.
    docs.health.columns.body = { purpose: "Something added with a partial review.", review: { covers: ["type:json"], verdict: "no-request-content", why: "This review names only one of the two flags the rules raise for the column." } };
    expect(checkInventory(schema, docs).join("\n")).toContain("health.body: the review covers [type:json] but the rules flag [name:content, type:json]");
  });

  test("declared agreement and scheduled content hold request text; no column holds a caller network address", () => {
    // This is the privacy invariant stated at the top of src/db/schema.ts. A column that breaks it must say so in its verdict, and
    // then this test (and the page's headline) change on purpose, in a reviewed commit.
    expect(columnsHoldingRequestData()).toEqual(["agreement_evidence.content", "agreement_jury.statement", "schedules.prompt_enc", "schedule_runs.reply_enc"]);
  });
});

describe("the page's summary claims only what the data proves", () => {
  const tables = buildInventory().postgres.tables;
  const ext: ExternalDoc = EXTERNAL;

  test("the inventory names retained agreement evidence and jury answer text, and lists other exceptions exactly", () => {
    const s = summarize(tables, ext);
    expect(s.headline).toContain("agreement_evidence.content"); expect(s.headline).toContain("agreement_jury.statement");
    const text = JSON.stringify(s);
    expect(text).toContain("response cache");
    expect(text).toContain("generations.attempts");
    expect(text).toContain("apps.url and apps.title");
    expect(text).toContain("3,601 seconds");
    expect(text).toContain("router reads the text of a request in memory");
  });

  test("a column reviewed as holding request text removes the claim, and a network address removes the address claim", () => {
    const changed = structuredClone(tables);
    const gen = changed.find((t) => t.name === "generations")!;
    gen.columns.find((c) => c.name === "request_sha256")!.review!.verdict = "holds-request-text";
    gen.columns.find((c) => c.name === "attempts")!.review!.verdict = "network-address";
    const s = summarize(changed, ext);
    expect(s.headline).not.toContain("We store no prompt or answer text");
    expect(s.headline).toContain("generations.request_sha256");
    expect(s.facts.join(" ")).not.toContain("No table has a column for a network address");
    expect(s.facts.join(" ")).toContain("generations.attempts");
  });

  test("the caveats come from the data: no sealed answer store means no cache caveat", () => {
    const noCache: ExternalDoc = { ...ext, redis: { ...ext.redis, families: ext.redis.families.map((f) => ({ ...f, requestText: undefined })) } };
    expect(summarize(tables, noCache).caveats.map((c) => c.title).join("|")).not.toContain("response cache");
  });
});

describe("the published document", () => {
  test("web/app/keep/inventory.generated.json is exactly what the code generates (run: bun scripts/gen-inventory.ts)", () => {
    const committed = readFileSync(join(ROOT, "web/app/keep/inventory.generated.json"), "utf8");
    expect(committed).toBe(inventoryJson());
    expect(sha256(committed)).toBe(inventoryDigest());
  });

  test("it is canonical JSON with a format marker, every category and both halves of the inventory", () => {
    const doc = buildInventory();
    expect(doc.format).toBe(INVENTORY_FORMAT);
    expect(inventoryJson()).toBe(canonicalJson(JSON.parse(inventoryJson())));
    expect(doc.categories.map((c) => c.id)).toEqual(["request", "billing", "receipts", "keys", "providers", "chain", "operations"]);
    expect(doc.postgres.tables.length).toBe(schemaTables().length);
    for (const c of doc.categories) expect(doc.postgres.tables.some((t) => t.category === c.id), c.id).toBe(true);
    for (const t of doc.postgres.tables) {
      expect(t.purpose.length).toBeGreaterThan(8);
      expect(["yes", "aggregate", "no"]).toContain(t.about_request);
      for (const col of t.columns) expect(["yes", "aggregate", "no"]).toContain(col.about_request);
    }
    expect(Object.keys(doc.outside_postgres as object).sort()).toEqual(["address_readers", "body_readers", "browser", "logs", "other_stores", "redis"]);
  });

  test("the digest changes when a description changes", () => {
    const docs = structuredClone(TABLE_DOCS) as Record<string, TableDoc>;
    docs.kv.columns.updated_at = "When the row was last changed, in UTC.";
    const changed = buildInventory(schemaTables(), docs);
    expect(inventoryDigest(changed)).not.toBe(inventoryDigest());
    expect(inventoryDigest()).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---- statements about the source -------------------------------------------------------------------------------------

type Ev = { file: string; contains: string };
function evidenceOf(node: unknown, out: Ev[] = []): Ev[] {
  if (Array.isArray(node)) node.forEach((x) => evidenceOf(x, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.file === "string" && typeof o.contains === "string") out.push({ file: o.file, contains: o.contains });
    for (const v of Object.values(o)) evidenceOf(v, out);
  }
  return out;
}

describe("evidence", () => {
  test("every statement about the source points at a file that exists and still contains the quoted line", () => {
    const evidence = evidenceOf(EXTERNAL);
    expect(evidence.length).toBeGreaterThan(60);
    const missing = evidence.filter((e) => !existsSync(join(ROOT, e.file))).map((e) => `${e.file} does not exist`);
    expect(missing).toEqual([]);
    const gone = evidence.filter((e) => !readFileSync(join(ROOT, e.file), "utf8").includes(e.contains)).map((e) => `${e.file} no longer contains: ${e.contains}`);
    expect(gone).toEqual([]);
  });
});

describe("Redis", () => {
  const families = EXTERNAL.redis.families;
  type Scanned = { file: string; prefix: string; address: boolean; window: number | null };
  const scanned: Scanned[] = [];
  for (const f of files) {
    for (const c of findCalls(f, /\blimiter\.take\(/)) {
      const window = /^\d[\d_]*$/.test((c.args[3] ?? "").trim()) ? Number((c.args[3] ?? "").trim().replaceAll("_", "")) / 1000 : null;
      for (const lit of literals(c.args[0] ?? "")) scanned.push({ file: f, prefix: lit.split("${")[0], address: lit.includes("from.id"), window });
    }
    // chat.ts limits through limitOrThrow, which always counts a 60-second window.
    for (const c of findCalls(f, /\blimitOrThrow\((?=ctx\s*,)/)) for (const lit of literals(c.args[1] ?? "")) scanned.push({ file: f, prefix: lit.split("${")[0], address: lit.includes("from.id"), window: 60 });
  }

  test("every rate-limit key in the source is described, and nothing described has gone", () => {
    const inCode = [...new Set(scanned.map((s) => s.prefix))].sort();
    const described = families.filter((f) => f.limiterPrefix !== undefined).map((f) => f.limiterPrefix!).sort();
    expect(inCode.length).toBeGreaterThan(15);
    expect(inCode).toEqual(described);
  });

  test("a key that contains the caller's address is marked as such, and only those", () => {
    for (const s of scanned) {
      const family = families.find((f) => f.limiterPrefix === s.prefix)!;
      expect(family.holds === "address", `${s.file}: ${s.prefix}`).toBe(s.address);
    }
    expect(families.filter((f) => f.holds === "address").length).toBeGreaterThanOrEqual(9);
  });

  test("the stated window matches the code, and the lifetime is the window plus one second", () => {
    for (const s of scanned) {
      if (s.window === null) continue;
      const family = families.find((f) => f.limiterPrefix === s.prefix)!;
      expect(family.windowSeconds, `${s.file}: ${s.prefix}`).toBe(s.window);
      expect(family.ttl).toContain(`${(s.window + 1).toLocaleString("en-US")} seconds`);
    }
  });

  test("the other Redis keys the router writes are described, and no new file talks to Redis unannounced", () => {
    const prefixes = new Set<string>();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/redis\.[a-z]+\(\s*[`"']([^`"'$]*)/g)) prefixes.add(m[1]);
      for (const m of src.matchAll(/[`"'](rl):\$/g)) prefixes.add(`${m[1]}:`);
    }
    expect([...prefixes].sort()).toEqual(["cache:", "rl:", "walletauth:"]);
    for (const p of prefixes) expect(families.some((f) => f.key.startsWith(p)), p).toBe(true);
    const users = files.filter((f) => /["']ioredis["']|["']bullmq["']/.test(read(f)));
    expect(users).toEqual(["src/api/auth.ts", "src/app.ts", "src/gateway/cache.ts", "src/lib/ratelimit.ts", "src/pay/recovery.ts", "src/services/batches.ts", "src/services/jobs.ts"]);
    // The Batch API writes its sealed requests and answers under keys it builds from the batch id (services/batches.ts).
    expect(families.filter((f) => f.requestText === "request-and-answer-text").map((f) => f.key)).toEqual(["batch:<batch id>:in and batch:<batch id>:out"]);
    expect(families.some((f) => f.key.startsWith("bull:anyroute-jobs-"))).toBe(true);
  });

  test("only the response cache, retry protection and x402 payment recovery are marked as holding answer text, and they are the only keys that are not a counter or a marker", () => {
    expect(families.filter((f) => f.requestText === "answer-text").map((f) => f.key)).toEqual(["idempotency:<sha256>", "cache:<sha256>", "x402paid:<sha256>"]);
  });

  test("the stated lifetime of a rate-limit key is what the limiter sets", () => {
    const src = read("src/lib/ratelimit.ts");
    expect(src).toContain("this.redis.pexpire(k, windowMs + 1000)");
    expect(src).toContain("const k = `rl:${key}:${start}`");
  });
});

describe("the application log", () => {
  const FORBIDDEN =
    /(\bc\.req\b|\breq\.|\brequest\.|headers?\b|\bbody\b|\bmessages\b|(?<![.\w])message\b|prompt|\bcontent\b|clientIp|addressBucket|from\.id|requestIP|authorization|cookie|bearer|x-forwarded|user-?agent|\bip\b|\bquery\b|\.text\b)/i;
  const calls = files.flatMap((f) => findCalls(f, /\blog\.(debug|info|warn|error)\(/));

  test("no log call passes a body, a header, a prompt, a query, or a caller's address", () => {
    expect(calls.length).toBeGreaterThan(80);
    const allowed = [{ file: "src/app.ts", contains: "path: new URL(c.req.url).pathname" }];
    const offenders = calls
      .filter((c) => FORBIDDEN.test(c.args.slice(1).join(",")))
      .filter((c) => !allowed.some((a) => a.file === c.file && c.text.includes(a.contains)))
      .map((c) => `${c.file}:${c.line} ${c.text.slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  test("the one log call that reads the request logs its path without the query string", () => {
    const reads = calls.filter((c) => /\bc\.req\b/.test(c.text));
    expect(reads.map((c) => c.file)).toEqual(["src/app.ts"]);
    expect(reads[0].text).toContain("new URL(c.req.url).pathname");
    expect(reads[0].text).not.toContain(".search");
  });

  test("nothing but the logger writes to the console", () => {
    const direct = files.filter((f) => f !== "src/lib/util.ts").filter((f) => /\bconsole\.(log|error|warn|info|debug)\(/.test(read(f)));
    expect(direct).toEqual([]);
  });
});

describe("who reads a caller's address, and who reads a request body", () => {
  test("every file that reads a caller's address is described", () => {
    const readers = files.filter((f) => /\bclientIp\(|\baddressBucket\(|\bAddressBucket\b|requestIP|x-forwarded-for|x-real-ip|cf-connecting-ip|remoteAddress/.test(read(f)));
    const described = EXTERNAL.addressReaders.map((r) => r.file);
    expect(readers.filter((f) => !described.includes(f))).toEqual([]);
    for (const r of EXTERNAL.addressReaders) expect(existsSync(join(ROOT, r.file)), r.file).toBe(true);
  });

  test("every file that reads a request body is described", () => {
    const readers = files.filter((f) => f !== "src/providers/mock.ts").filter((f) => /\breadJson\(c\)|\bc\.req\.(text|json|arrayBuffer|blob|formData)\(|\bc\.req\.raw\.body\b|\breadCapped\(raw\.body\b/.test(read(f)));
    const described = EXTERNAL.bodyReaders.map((r) => r.file);
    expect(readers.filter((f) => !described.includes(f))).toEqual([]);
    for (const r of EXTERNAL.bodyReaders) expect(existsSync(join(ROOT, r.file)), r.file).toBe(true);
  });

  test("the routes that carry prompts or answers are the ones that say so", () => {
    const carry = EXTERNAL.bodyReaders.filter((r) => r.carries === "prompt-or-answer").map((r) => r.file);
    expect(carry).toEqual(expect.arrayContaining(["src/api/chat.ts", "src/api/embeddings.ts", "src/api/anthropic.ts", "src/api/responses.ts", "src/api/mcp.ts", "src/api/rag.ts", "src/ohttp/gateway.ts", "src/gateway/cache.ts"]));
  });
});

describe("public wording", () => {
  test("the inventory text avoids words the site does not use", () => {
    const text = inventoryJson().toLowerCase();
    for (const word of ["demo", "mock", "placeholder", "simulated", "we do not log", "no logs", "cannot read"]) {
      // The schema has a column named simulated; its name is the only place the word appears.
      const stripped = word === "simulated" ? text.replaceAll('"name":"simulated"', "") : text;
      expect(stripped.includes(word), word).toBe(false);
    }
    expect(/\btests?\b/.test(text.replace(/"name":"[a-z_]+"/g, ""))).toBe(false);
  });
});
