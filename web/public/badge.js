/*! Anyroute attestation badge. No dependencies, no cookies, no tracking.
 *  <script src="https://<router>/badge.js" data-endpoint="<provider id or model id>" data-theme="light|dark|auto" async></script>
 *  It reads the router's public records from the viewer's browser, checks that they agree and are current, and shows
 *  only what every check backs. The hardware quote itself is verified by the router, not here: the badge says so. */
(function (root) {
  "use strict";
  var SKEW_MS = 5 * 60 * 1000; // how far the router's reading may be from this browser's clock
  var HEX64 = /^(?:sha256:|0x)?[0-9a-f]{64}$/i;
  var LABEL = { attested: "Attested", policy: "Policy", "vendor-forwarded": "Vendor-forwarded", unverified: "Unverified", checking: "Checking" };

  function short(h) {
    var m = typeof h === "string" && /^(?:sha256:|0x)?([0-9a-f]{8})[0-9a-f]*$/i.exec(h);
    return m ? m[1].toLowerCase() : null;
  }
  /** "99.8%": truncated to one decimal, so only a full share reads 100%. */
  function shareText(s) {
    var t = Math.floor(Math.min(1, Math.max(0, s)) * 1000 + 1e-9) / 10;
    return (t % 1 === 0 ? String(t) : t.toFixed(1)) + "%";
  }
  function span(ms) {
    return ms >= 172800000 ? Math.floor(ms / 86400000) + " d" : Math.floor(ms / 3600000) + " h";
  }
  function time(v) {
    var t = typeof v === "string" ? Date.parse(v) : NaN;
    return isFinite(t) ? t : NaN;
  }
  function digest(d) {
    return d ? d.compose_hash || d.image_digest || d.model_digest || null : null;
  }

  /**
   * What the badge may say, from the router's public records as fetched in this browser:
   *   summary     GET /api/v1/attestation/summary (data), or null when unavailable
   *   record      GET /api/v1/attestation/{provider} (data) for the provider behind the badge
   *   cls         the disclosure class the router serves that endpoint under right now
   *   model       for a model badge: its entry in GET /api/v1/models, and endpoint: its attested endpoint
   * Attested only when every check passes. Nothing is upgraded; a failed check reads Unverified.
   */
  function evaluate(input, now) {
    var i = input || {};
    var checks = [];
    var add = function (name, ok, text) { checks.push({ name: name, ok: ok, text: text }); return ok; };
    var out = function (state, note, facts, provider) {
      return { state: state, label: LABEL[state], note: note || null, facts: facts || [note || "no fresh attestation"], checks: checks, provider: provider || null };
    };
    if (i.error) return out("unverified", i.error);
    var cls = i.cls === "attested" || i.cls === "policy" || i.cls === "vendor-forwarded" ? i.cls : null;
    if (!cls) return out("unverified", "not listed");
    if (cls !== "attested") return out(cls, "no fresh attestation", null, i.provider);

    var s = i.summary, r = i.record || {};
    var entry = null;
    if (s && Array.isArray(s.providers)) for (var k = 0; k < s.providers.length; k++) if (s.providers[k] && s.providers[k].provider === i.provider) entry = s.providers[k];
    var gen = time(s && s.generated_at);
    if (!add("current", isFinite(gen) && Math.abs(now - gen) <= SKEW_MS, "The router's record was read within 5 minutes of this browser's clock.")) return out("unverified", s ? "record not current" : "no public record", null, i.provider);
    var at = time(r.attested_at), win = s.fresh_within_ms;
    add("fresh", r.status === "attested" && isFinite(at) && typeof win === "number" && gen - at >= -SKEW_MS && gen - at <= win, "The last verified attestation is inside the router's freshness window.");
    add("agree", !!entry && entry.status === "attested", "The attestation record and the proof-time summary both say attested.");
    var rd = digest(r.measurement), sd = digest(entry && entry.measurement && entry.measurement.digests);
    add("measurement", !rd || !sd || rd === sd, "The measurement in the record matches the one in the summary.");
    var policy = r.policy_hash == null ? null : r.policy_hash;
    if (i.model) {
      var a = i.model.attestation || {};
      var e = i.endpoint || {};
      add("model", a.best === "attested" && e.disclosure === "attested", "The model's attestation object and its endpoint are both attested.");
      add("policy", (a.policy_hash == null ? null : a.policy_hash) === (e.policy_hash == null ? null : e.policy_hash) && (e.policy_hash == null || e.policy_hash === policy), "The policy hash in the model's attestation object matches its endpoint and the attestation record.");
      policy = a.policy_hash == null ? null : a.policy_hash;
    }
    add("policy-form", policy === null || HEX64.test(policy), "The policy hash is a well-formed SHA-256.");
    for (var c = 0; c < checks.length; c++) if (!checks[c].ok) return out("unverified", "records disagree", null, i.provider);

    var facts = [];
    var m = short(rd || sd);
    if (m) facts.push("measure " + m);
    facts.push(policy ? "policy " + short(policy) : "no policy hash");
    var w = entry.fresh && entry.fresh["7d"];
    if (w && typeof w.share === "number" && w.observed_ms >= 3600000) facts.push(shareText(w.share) + " of " + (w.history_complete ? "7 d" : span(w.observed_ms)));
    return out("attested", null, facts, i.provider);
  }

  // ---- fetching ----------------------------------------------------------------------------------------------------

  function path(id) { return id.split("/").map(encodeURIComponent).join("/"); }
  function get(base, p) {
    return fetch(base + p, { credentials: "omit", headers: { accept: "application/json" } }).then(function (res) {
      if (!res.ok) { var e = new Error(String(res.status)); e.status = res.status; throw e; }
      return res.json();
    });
  }
  function soft(pr) { return pr.then(function (j) { return j; }, function () { return null; }); }

  function gather(base, id) {
    var summary = soft(get(base, "/api/v1/attestation/summary")).then(function (j) { return j && j.data; });
    var provider = function (pid) {
      return Promise.all([summary, soft(get(base, "/api/v1/attestation/" + encodeURIComponent(pid))), get(base, "/api/v1/disclosure/" + encodeURIComponent(pid))]).then(function (x) {
        var cur = x[2] && x[2].data && x[2].data.current;
        return { summary: x[0], record: x[1] && x[1].data, cls: cur && !cur.simulated ? cur.class : null, provider: pid };
      });
    };
    if (id.indexOf("/") < 0) return provider(id);
    return Promise.all([get(base, "/api/v1/models"), soft(get(base, "/api/v1/models/" + path(id) + "/endpoints"))]).then(function (x) {
      var list = (x[0] && x[0].data) || [], model = null;
      for (var k = 0; k < list.length; k++) if (list[k] && list[k].id === id) model = list[k];
      if (!model) return { cls: null };
      var a = model.attestation || {}, eps = (x[1] && x[1].data && x[1].data.endpoints) || [], ep = null;
      for (var n = 0; n < eps.length; n++) if (eps[n].disclosure === "attested" && (!ep || eps[n].policy_hash === a.policy_hash)) ep = eps[n];
      if (a.best !== "attested" || !ep) return { cls: a.best === "attested" ? null : a.best || "vendor-forwarded" };
      return provider(ep.provider_slug).then(function (p) { p.model = model; p.endpoint = ep; return p; });
    });
  }

  // ---- drawing -----------------------------------------------------------------------------------------------------

  var CSS =
    ":host{all:initial;display:inline-block;vertical-align:middle}" +
    "a{--bg:#f5f5f0;--fg:#0b0c0b;--muted:#5b605a;--signal:#0a7d31;display:inline-grid;gap:5px;padding:11px 14px 10px;background:var(--bg);color:var(--fg);text-decoration:none;font:400 13px/1.2 'Host Grotesk Variable','Host Grotesk',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;min-width:200px;max-width:100%;box-sizing:border-box}" +
    "a[data-theme=dark]{--bg:#0b0c0b;--fg:#f5f5f0;--muted:#979d96;--signal:#1fe15a}" +
    "@media (prefers-color-scheme:dark){a[data-theme=auto]{--bg:#0b0c0b;--fg:#f5f5f0;--muted:#979d96;--signal:#1fe15a}}" +
    "a:focus-visible{outline:2px solid var(--signal);outline-offset:2px}" +
    ".row{display:flex;align-items:center;gap:8px;white-space:nowrap}" +
    "i{width:9px;height:9px;flex:none;box-sizing:border-box;border:1.5px solid var(--muted)}" +
    "i[data-state=attested]{background:var(--signal);border-color:var(--signal)}i[data-state=policy]{background:var(--muted)}" +
    "b{font-weight:620;letter-spacing:-.01em}" +
    ".id,.facts,.brand,.here{font-family:'Martian Mono Variable','Martian Mono',ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}" +
    ".id{font-size:10px;overflow:hidden;text-overflow:ellipsis;max-width:220px}.brand{margin-left:auto;padding-left:14px;font-size:8px;letter-spacing:.11em;text-transform:uppercase}" +
    ".facts,.here{font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.here{font-size:8.5px}";

  function draw(host, v, id, theme, href) {
    var shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    var passed = 0;
    for (var k = 0; k < v.checks.length; k++) if (v.checks[k].ok) passed++;
    var title = "Anyroute: " + id + " is " + v.label + "." +
      (v.state === "attested" ? " Checked in this browser: " + v.checks.map(function (c) { return c.text; }).join(" ") + " The hardware quote itself is verified by the router, not here." : v.note ? " " + v.note.charAt(0).toUpperCase() + v.note.slice(1) + "." : "");
    var a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener"; a.title = title;
    a.setAttribute("data-theme", theme); a.setAttribute("aria-label", title);
    var row = document.createElement("span"); row.className = "row";
    var mark = document.createElement("i"); mark.setAttribute("data-state", v.state); mark.setAttribute("aria-hidden", "true");
    var b = document.createElement("b"); b.textContent = v.label;
    var idEl = document.createElement("span"); idEl.className = "id"; idEl.textContent = id;
    var brand = document.createElement("span"); brand.className = "brand"; brand.textContent = "Anyroute";
    row.appendChild(mark); row.appendChild(b); row.appendChild(idEl); row.appendChild(brand);
    var facts = document.createElement("span"); facts.className = "facts"; facts.textContent = v.facts.join("  ·  ");
    a.appendChild(row); a.appendChild(facts);
    if (v.state === "attested") { var here = document.createElement("span"); here.className = "here"; here.textContent = passed + " of " + v.checks.length + " checks passed in your browser"; a.appendChild(here); }
    var style = document.createElement("style"); style.textContent = CSS;
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
    shadow.appendChild(style);
    shadow.appendChild(a);
  }

  function mount(script) {
    if (script.getAttribute("data-anyroute-badge") === "on") return;
    script.setAttribute("data-anyroute-badge", "on");
    var id = (script.getAttribute("data-endpoint") || "").trim();
    var theme = script.getAttribute("data-theme");
    theme = theme === "dark" || theme === "auto" ? theme : "light";
    var base;
    try { base = new URL(script.getAttribute("data-api") || script.src, root.location.href).origin; } catch (e) { return; }
    var host = document.createElement("span");
    host.className = "anyroute-badge";
    script.parentNode.insertBefore(host, script.nextSibling);
    var registry = base + "/registry/";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/.test(id)) return draw(host, evaluate({ cls: null }, Date.now()), id || "no endpoint", theme, registry);
    draw(host, { state: "checking", label: "Checking", facts: ["reading the router's public record"], checks: [] }, id, theme, registry);
    var run = function () {
      gather(base, id).then(function (input) { return input; }, function () { return { error: "router not reached" }; }).then(function (input) {
        var v = evaluate(input, Date.now());
        draw(host, v, id, theme, v.provider ? registry + encodeURIComponent(v.provider) + "/" : registry);
      });
    };
    run();
    setInterval(function () { if (!document.hidden) run(); }, 5 * 60 * 1000);
  }

  root.AnyrouteBadge = { evaluate: evaluate, shareText: shareText, version: 1 };
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  var scan = function () {
    var list = document.querySelectorAll("script[data-endpoint]");
    for (var k = 0; k < list.length; k++) if (/\/badge\.js(?:[?#]|$)/.test(list[k].src || "")) mount(list[k]);
  };
  if (document.currentScript && document.currentScript.hasAttribute("data-endpoint")) mount(document.currentScript);
  scan();
  root.AnyrouteBadge.scan = scan;
})(typeof window !== "undefined" ? window : this);
