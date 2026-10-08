import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A production worker only runs jobs named in WORKER_JOBS, and src/config.ts refuses names missing from its allow-list
// (that check only runs in production). A job registered in code but not allowed there silently never runs in production
// (136-145: three jobs), so every registered name must appear in the allow-list.
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
});
const registered = [...new Set(files("src").flatMap(path =>
  [...readFileSync(path, "utf8").matchAll(/jobs\.register\(\s*["'`]([a-z0-9-]+)["'`]/g)].map(m => m[1])))].sort();
const config = readFileSync("src/config.ts", "utf8");
const start = config.indexOf("const allowed = [");
const block = config.slice(start, config.indexOf("Worker requires an explicit valid WORKER_JOBS list", start));
const allowed = new Set([...block.matchAll(/["']([a-z0-9-]+)["']/g)].map(m => m[1]));

test("every job registered in src/ is on the production WORKER_JOBS allow-list", () => {
  expect(start).toBeGreaterThan(0);
  expect(registered.length).toBeGreaterThan(10);
  expect(registered.filter(job => !allowed.has(job))).toEqual([]);
});
