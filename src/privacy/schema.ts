import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.ts";

export type SchemaColumn = { name: string; type: string; nullable: boolean };
export type SchemaTable = { name: string; columns: SchemaColumn[] };

/** Every table and column declared in src/db/schema.ts, sorted by name, read from the drizzle definitions. */
export function schemaTables(): SchemaTable[] {
  const out: SchemaTable[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const t = getTableConfig(value);
    out.push({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.getSQLType(), nullable: !c.notNull })) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}
