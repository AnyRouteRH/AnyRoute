import type { Hono } from "hono";
import type { Ctx } from "../context.ts";

// A small built-in page: models (price, providers, attested, creator royalty), rankings and the
// two-line migration. Everything on it comes from the public API at render time.

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anyroute</title>
<style>
:root{--bg:#fbfbf9;--fg:#15161a;--muted:#62656e;--line:#e3e3de;--card:#fff;--accent:#0b7a4b;--chip:#eef4f0}
@media (prefers-color-scheme:dark){:root{--bg:#101113;--fg:#ecece8;--muted:#9a9ca3;--line:#26282d;--card:#16171a;--accent:#3ccf8e;--chip:#1c2a23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1080px;margin:0 auto;padding:40px 16px 64px}h1{font-size:32px;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 28px}section{margin:28px 0}h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:13px}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font-size:13px}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}table{border-collapse:collapse;width:100%;min-width:640px}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{font-size:12px;color:var(--muted);font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}tr:last-child td{border-bottom:0}.chip{display:inline-block;background:var(--chip);color:var(--accent);border-radius:99px;padding:1px 8px;font-size:12px}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head><body><main>
<h1>Anyroute</h1><p class="sub">Any model. One key. Paid per call — USDG on Robinhood Chain, 0% prepaid, signed receipts, bonded providers.</p>
<section><div class="grid" id="stats"></div></section>
<section><h2>Switch in two lines</h2><pre><code>const client = new OpenAI({
  baseURL: "<span id="base"></span>/api/v1",
  apiKey: "sk-ar-v1-…",            // POST /api/v1/keys, deposit USDG to its key hash
});</code></pre></section>
<section><h2>Models</h2><div class="tw"><table><thead><tr><th>Model</th><th class="n">Prompt $/M</th><th class="n">Completion $/M</th><th class="n">Context</th><th class="n">Providers</th><th>Private</th><th>Creator royalty</th></tr></thead><tbody id="models"></tbody></table></div></section>
<section><h2>Rankings · last 24h</h2><div class="tw"><table><thead><tr><th>Model</th><th class="n">Tokens</th><th class="n">Requests</th><th class="n">Paid to creator</th></tr></thead><tbody id="rank"></tbody></table></div></section>
</main><script>
const $=(id)=>document.getElementById(id);const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const perM=(p)=>(Number(p)*1e6).toFixed(Number(p)*1e6<1?3:2);const fmt=(n)=>Intl.NumberFormat("en",{notation:"compact"}).format(n);
$("base").textContent=location.origin;
Promise.all([fetch("/api/v1/models").then(r=>r.json()),fetch("/api/v1/rankings?period=day").then(r=>r.json()),fetch("/api/v1/status").then(r=>r.json())]).then(([m,rk,st])=>{
 const s=st.data;$("stats").innerHTML=[["Models",s.catalog.models],["Providers",s.catalog.providers],["Tokens · 24h",fmt(s.launch.tokens_24h)],["Prepaid fee","0%"],["Per-call margin",(s.fees.per_call_margin_bps/100)+"%"],["Chain",s.chain.chain_id]].map(([k,v])=>'<div class="stat"><b>'+esc(v)+'</b><span>'+esc(k)+'</span></div>').join("");
 $("models").innerHTML=m.data.map(x=>'<tr><td><code>'+esc(x.id)+'</code></td><td class="n">'+perM(x.pricing.prompt)+'</td><td class="n">'+perM(x.pricing.completion)+'</td><td class="n">'+fmt(x.context_length)+'</td><td class="n">'+x.data_policy.providers+'</td><td>'+(x.attested_available?'<span class="chip">attested</span>':'')+'</td><td>'+(x.creator?(x.royalty_bps/100)+'% → <code>'+esc(x.creator.slice(0,8))+'…</code>':'')+'</td></tr>').join("")||'<tr><td colspan="7">No models yet.</td></tr>';
 $("rank").innerHTML=rk.data.models.map(x=>'<tr><td><code>'+esc(x.model)+'</code></td><td class="n">'+fmt(x.tokens)+'</td><td class="n">'+fmt(x.requests)+'</td><td class="n">$'+x.paid_to_creator_usd.toFixed(4)+'</td></tr>').join("")||'<tr><td colspan="4">No traffic yet.</td></tr>';
}).catch(()=>{$("stats").textContent="Could not load live data."});
</script></body></html>`;

export function siteRoutes(app: Hono, _ctx: Ctx) {
  app.get("/", (c) => c.html(PAGE, 200, { "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" }));
}
