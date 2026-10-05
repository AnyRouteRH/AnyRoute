import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Drizzle applies only migrations whose journal `when` is later than the newest one already applied, so a
// migration that lands with an older `when` (or out of order) is skipped in production without an error.
const folder = resolve(import.meta.dir, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("migration journal", () => {
  test("idx and when strictly increase in journal order", () => {
    const { entries } = journal;
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].idx, `${entries[i].tag} idx`).toBeGreaterThan(entries[i - 1].idx);
      expect(entries[i].when, `${entries[i].tag} when must be later than ${entries[i - 1].tag}`).toBeGreaterThan(entries[i - 1].when);
    }
  });

  test("every journal tag has its SQL file, and every SQL file is in the journal", () => {
    const files = readdirSync(folder).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4)).sort();
    for (const e of journal.entries) {
      expect(files, `${e.tag}.sql exists`).toContain(e.tag);
    }
    expect(files).toEqual(journal.entries.map((e) => e.tag).sort());
  });
});
