import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteCsp } from "../src/lib/csp.ts";

const root = mkdtempSync(join(tmpdir(), "anyroute-csp-"));
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "index.html"), '<html><head><script src="/_next/static/a.js"></script><script>self.x=1</script></head><body></body></html>');
writeFileSync(join(root, "docs/index.html"), "<html><body><script>self.y=2</script></body></html>");
afterAll(() => rmSync(root, { recursive: true }));
const directives = (csp: string) => new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

test("site CSP allows only same-origin fetches, images and fonts", () => {
  const d = directives(siteCsp(root));
  expect(d.get("default-src")).toEqual(["'self'"]);
  expect(d.get("connect-src")).toEqual(["'self'"]);
  expect(d.get("img-src")).toEqual(["'self'"]);
  expect(d.get("font-src")).toEqual(["'self'"]);
  expect(d.get("object-src")).toEqual(["'none'"]);
  expect(d.get("base-uri")).toEqual(["'none'"]);
  expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  for (const values of d.values()) for (const v of values) expect(["https:", "http:", "wss:", "ws:", "data:", "blob:", "*"]).not.toContain(v);
});

test("site CSP hashes each inline script of the export and nothing else", () => {
  const script = directives(siteCsp(root)).get("script-src")!;
  expect(script.sort()).toEqual(["'self'", hash("self.x=1"), hash("self.y=2")].sort());
  expect(script).not.toContain("'unsafe-inline'");
  expect(script).not.toContain("'unsafe-eval'");
});
