import type { Hono } from "hono";
import { stream } from "hono/streaming";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { CSV_COLUMNS, ledgerCsvRow, ledgerQuery, readAgentLedger } from "../agents/ledger.ts";
import { ownedKey, principal } from "./agents.ts";
import { requireKey } from "./auth.ts";
export function agentLedgerRoutes(app: Hono, ctx: Ctx) {
  for (const self of [true, false]) app.get(self ? "/api/v1/agents/me/ledger" : "/api/v1/agents/:key_hash/ledger", async c => {
    if (!ctx.cfg.agentPolicyEnabled) fail(404, "Not found.", "not_found");
    const key = self ? await requireKey(ctx, c.req.header("authorization")) : await ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash")!);
    const query = ledgerQuery(c.req.query());
    const page = await readAgentLedger(ctx.db, key.keyHash, query);
    c.header("cache-control", "no-store");
    if (query.format === "json") return c.json(page);
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="agent-ledger.csv"');
    if (page.next_cursor) c.header("x-next-cursor", page.next_cursor);
    c.header("access-control-expose-headers", "x-next-cursor");
    return stream(c, async output => { await output.write(CSV_COLUMNS.join(",") + "\r\n"); for (const row of page.data.rows) { if (output.aborted) break; await output.write(ledgerCsvRow(row)); } });
  });
}
