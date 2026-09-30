// Public, static-only product preview. This process never starts the router or chain workers.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { siteCsp } from "../src/lib/csp.ts";

export function previewHandler(directory: string) {
  const root = realpathSync(directory);
  const csp = siteCsp(root).replace("connect-src 'self' https: wss:", "connect-src 'self'");
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain" };
  const banner = '<aside aria-label="Preview notice" style="position:relative;z-index:1000;padding:10px 18px;background:#1fe15a;color:#0b0c0b;text-align:center;font:600 14px system-ui">Anyroute preview · Sample data only · No live inference or payments</aside>';
  return (req: Request): Response => {
    const url = new URL(req.url);
    const headers = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": csp, "cache-control": "no-store" };
    const json = (data: unknown, status: number) => Response.json(data, { status, headers });
    if (url.pathname === "/health") return json({ ok: true, mode: "static-demo", payments: false }, 200);
    if (/^\/(api|v1|trpc|ready)(\/|$)/.test(url.pathname)) return json({ error: { code: "preview_only", message: "This preview has no live API or payment service." } }, 503);
    if (!["GET", "HEAD"].includes(req.method)) return new Response("Method not allowed", { status: 405, headers });
    if (/^\/dashboard\/?$/.test(url.pathname) && url.searchParams.get("demo") !== "1") {
      url.pathname = "/dashboard/"; url.searchParams.set("demo", "1");
      return new Response(null, { status: 302, headers: { ...headers, location: url.pathname + url.search } });
    }
    try {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.split("/").some((part) => part.startsWith("."))) return new Response("Not found", { status: 404, headers });
      let file = resolve(root, "." + pathname);
      if (file !== root && !file.startsWith(root + sep)) return new Response("Not found", { status: 404, headers });
      if (statSync(file).isDirectory()) file = resolve(file, "index.html");
      file = realpathSync(file);
      if (!file.startsWith(root + sep) || !statSync(file).isFile()) return new Response("Not found", { status: 404, headers });
      const type = mime[extname(file)] ?? "application/octet-stream";
      let body: string | Uint8Array = readFileSync(file);
      if (type.startsWith("text/html")) body = Buffer.from(body).toString().replace(/(<body\b[^>]*>)/i, "$1" + banner);
      return new Response(req.method === "HEAD" ? null : body, { headers: { ...headers, "content-type": type } });
    } catch { return new Response("Not found", { status: 404, headers }); }
  };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? "web/out");
  Bun.serve({ hostname: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8787), fetch: previewHandler(root) });
  console.log("Anyroute static preview started; live API and payments are disabled.");
}
