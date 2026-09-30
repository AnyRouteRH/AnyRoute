// Serve the example: bundles example/main.tsx (React included) and serves it with index.html.
//   bun run example            # http://localhost:5178
//   PORT=8080 bun run example
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const port = Number(process.env.PORT) || 5178;

async function bundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(here, "main.tsx")], target: "browser", format: "esm", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  if (!out.success) throw new AggregateError(out.logs, "example build failed");
  return out.outputs[0].text();
}

let js = await bundle();
Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/main.js") {
      if (process.env.WATCH) js = await bundle();
      return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (path === "/" || path === "/index.html") return new Response(Bun.file(join(here, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
});
console.log(`chat kit example on http://localhost:${port}`);
