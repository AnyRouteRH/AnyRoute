// The migration job's image copies only the files src/db/schema.ts needs at runtime. A schema split into a new
// module must be copied too, or the job crashes and every new release refuses to start ("schema does not match").
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const dockerfile = readFileSync(join(ROOT, "deploy/railway/migrate.Dockerfile"), "utf8");
const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+/gm)].map((m) => m[1]);
const inImage = (file: string) => copied.some((c) => file === c || file.startsWith(c.replace(/\/$/, "") + "/"));

/** Relative runtime imports of a file (type-only imports are erased by Bun and need no file). */
function runtimeImports(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  return [...src.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm)].map((m) =>
    relative(ROOT, normalize(join(ROOT, dirname(file), m[1]))),
  );
}

describe("migration image", () => {
  test("copies every module the database schema loads at runtime", () => {
    const seen = new Set<string>();
    const queue = ["src/db/schema.ts", "scripts/migrate.ts"];
    const missing: string[] = [];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!inImage(file)) missing.push(file);
      for (const dep of runtimeImports(file)) if (!seen.has(dep)) queue.push(dep);
    }
    expect(missing).toEqual([]);
  });
});
