import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
/** Hash the exact inline scripts in the static export; never allow arbitrary inline JS.
 *  The site served by the router needs no other origin: the dashboard calls this router's API on the
 *  same origin, wallets are reached through the injected `window.ethereum` provider (the wallet, not
 *  the page, talks to the chain), and fonts, icons and scripts are self-hosted. A site built with
 *  NEXT_PUBLIC_ANYROUTE_API_URL is hosted apart from the router and needs its own policy. */
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
  return `default-src 'self'; script-src 'self' ${[...hashes].join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

/** Origins have already passed ZKAPI_PAGE_ORIGINS validation at startup. */
export function zkapiCsp(path: string, sitePolicy: string, origins: readonly string[]): string | undefined {
  if (!origins.length) return undefined;
  const sources = origins.join(" ");
  if (path === "/zkapi/prover-worker.js") return `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${sources}`;
  if (!["/zkapi", "/zkapi/", "/zkapi/index.html", "/zkapi.html"].includes(path)) return undefined;
  return `${sitePolicy.replace("connect-src 'self'", `connect-src 'self' ${sources}`)}; worker-src 'self'`;
}
