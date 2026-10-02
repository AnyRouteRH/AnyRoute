import type { Hono } from "hono";
import { ApiError } from "../lib/errors.ts";

export const MODEL_POST_PATHS = [
  "/api/v1/chat/completions", "/v1/chat/completions", "/api/v1/completions", "/v1/completions",
  "/api/v1/embeddings", "/v1/embeddings", "/api/v1/responses", "/v1/responses", "/api/v1/messages",
] as const;

export function acceptsHtml(accept = ""): boolean {
  return accept.split(",").some(part => {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const quality = params.map(p => p.trim()).find(p => p.startsWith("q="));
    return type === "text/html" && (!quality || (Number(quality.slice(2)) > 0 && Number(quality.slice(2)) <= 1));
  });
}
const FIRST_CALL_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";
export const firstCallCsp = (method: string, path: string, enabled: boolean) => enabled && method === "GET" && MODEL_POST_PATHS.some(value => value === path) ? FIRST_CALL_CSP : undefined;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function examples(path: string, base: string) {
  const model = "meta-llama/llama-3.3-70b-instruct";
  const body = path.endsWith("/embeddings") ? { model: "openai/text-embedding-3-small", input: "Hello" }
    : path.endsWith("/responses") ? { model, input: "Hello", max_output_tokens: 32 }
    : path.endsWith("/completions") && !path.includes("/chat/") ? { model, prompt: "Hello", max_tokens: 32 }
    : { model, messages: [{ role: "user", content: "Hello" }], max_tokens: 32 };
  const messages = path.endsWith("/messages");
  const headers = messages ? { "x-api-key": "YOUR_API_KEY", "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { authorization: "Bearer YOUR_API_KEY", "content-type": "application/json" };
  const url = base + path;
  const auth = messages ? '-H "x-api-key: $ANYROUTE_API_KEY" -H "anthropic-version: 2023-06-01"' : '-H "Authorization: Bearer $ANYROUTE_API_KEY"';
  return {
    curl: `curl ${JSON.stringify(url)} \\\n  ${auth} -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`,
    javascript: `const response = await fetch(${JSON.stringify(url)}, {\n  method: "POST",\n  headers: ${JSON.stringify(headers, null, 2)},\n  body: JSON.stringify(${JSON.stringify(body, null, 2)})\n});\nconsole.log(await response.json());`,
    python: `import json\nimport urllib.request\n\nrequest = urllib.request.Request(\n    ${JSON.stringify(url)},\n    data=json.dumps(${JSON.stringify(body)}).encode(),\n    headers=${JSON.stringify(headers)},\n    method="POST",\n)\nwith urllib.request.urlopen(request) as response:\n    print(json.load(response))`,
  };
}

function page(path: string, base: string) {
  const snippets = examples(path, base);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Make your first API call — AnyRoute</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f0;color:#0b0c0b;font:16px/1.5 system-ui,sans-serif}header{background:#0b0c0b;color:#f5f5f0;padding:16px 24px}header a{text-decoration:none;font-weight:600}main{max-width:800px;margin:40px auto;padding:0 20px}h1{font-size:clamp(28px,5vw,40px);line-height:1.15;letter-spacing:-.035em}h2{font-size:20px}a{color:inherit}a:focus-visible,summary:focus-visible{outline:2px solid #0a7d31;outline-offset:4px}pre{background:white;border:1px solid #d6d6d0;padding:16px;overflow:auto;font:13px/1.6 ui-monospace,monospace}code{overflow-wrap:anywhere}nav{display:flex;gap:24px;flex-wrap:wrap}summary{cursor:pointer}p{max-width:65ch}
</style></head><body><header><a href="/">AnyRoute</a></header><main><h1>This address is for code: send a POST request</h1><p><code>${escapeHtml(path)}</code> receives JSON from your app. Opening it in a browser sends a GET request instead.</p><p>Sign in with your wallet, add funds, then set <code>ANYROUTE_API_KEY</code> to your key in your shell. Replace <code>YOUR_API_KEY</code> in the JavaScript or Python example. Choose a model from <a href="/models/">the model list</a> that supports this endpoint.</p><h2>Send your first request</h2><pre><code>${escapeHtml(snippets.curl)}</code></pre><details><summary>JavaScript fetch</summary><pre><code>${escapeHtml(snippets.javascript)}</code></pre></details><details><summary>Python</summary><pre><code>${escapeHtml(snippets.python)}</code></pre></details><p>For ordinary calls, the router reads request text in memory to route it. <a href="/keep/">See what we keep</a>.</p><nav aria-label="Next steps"><a href="/docs/#quickstart">Read the quickstart</a><a href="/dashboard/">Open your account</a></nav></main></body></html>`;
}

/** Only fixed paths and operator configuration enter the page; no caller data is echoed or stored. */
export function firstCallRoutes(app: Hono, enabled: boolean, publicBaseUrl: string) {
  if (!enabled) return;
  for (const path of MODEL_POST_PATHS) {
    const html = page(path, publicBaseUrl.replace(/\/$/, ""));
    app.get(path, c => {
      if (c.req.method !== "GET") return c.notFound(); // Hono also dispatches HEAD through GET handlers.
      c.header("allow", "POST");
      c.header("vary", "Accept");
      c.header("cache-control", "no-store");
      if (acceptsHtml(c.req.header("accept"))) {
        c.header("content-security-policy", FIRST_CALL_CSP);
        return c.html(html);
      }
      return c.json(new ApiError(405, "This address is for code: send a POST request with JSON and your API key. Read /docs/#quickstart to get started.", "method_not_allowed").toJSON(), 405);
    });
  }
}
