import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
/** Hash the exact inline scripts in the static export; never allow arbitrary inline JS. */
export function siteCsp(root: string) {
  const hashes = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".html")) {
        const html = readFileSync(path, "utf8");
        for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
          if (!/\bsrc\s*=/.test(match[1]) && match[2]) hashes.add(`'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`);
        }
      }
    }
  };
  visit(root);
  return `default-src 'self'; script-src 'self' ${[...hashes].join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}
