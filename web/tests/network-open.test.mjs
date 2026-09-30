import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hostsOpen } from "../lib/network-hosts.js";
import { auditNetworkWording } from "../scripts/audit-network.mjs";

// Render the actual JSX with the repository's existing Bun toolchain.
const transpile = 'process.stdout.write(new Bun.Transpiler({ loader: "jsx", target: "node", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "React.createElement", jsxFragmentFactory: "React.Fragment" } } }).transformSync(await Bun.stdin.text()));';
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL) {
      for (const ext of [".jsx", ".js"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (fs.existsSync(url)) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: 'export default new Proxy({}, { get: (_, name) => name });' };
    if (url.endsWith(".jsx")) return {
      format: "module", shortCircuit: true,
      source: 'import React from "react";\n' + execFileSync("bun", ["-e", transpile], { input: fs.readFileSync(fileURLToPath(url), "utf8"), encoding: "utf8" }),
    };
    return next(url, context);
  },
});
const { default: NetworkContent } = await import("../app/network/NetworkContent.jsx");
const { default: NetworkAdmission, NetworkHostsContext } = await import("../app/network/NetworkAdmission.jsx");
hook.deregister();

function visible(html) {
  // Discard each hidden variant, including its nested spans/buttons.
  let match;
  while ((match = /<span\b[^>]*style="visibility:hidden"[^>]*>/.exec(html))) {
    let depth = 1, end = match.index + match[0].length;
    const tags = /<span\b[^>]*>|<\/span>/g;
    tags.lastIndex = end;
    for (let tag; depth && (tag = tags.exec(html));) { depth += tag[0] === "</span>" ? -1 : 1; end = tags.lastIndex; }
    assert.equal(depth, 0);
    html = html.slice(0, match.index) + html.slice(end);
  }
  return html;
}
const content = () => createElement(NetworkContent, { sha: "checker-digest", joinSha: "join-digest" });
const render = (open) => visible(renderToStaticMarkup(createElement(NetworkHostsContext.Provider, { value: open }, content())));
const hero = "The AnyRoute Network is coming: confidential hardware, owned by anyone, serving private AI and paid per token served. Hosting isn’t open yet. Join the waitlist and check your hardware now.";

test("static rendering and loading retain today's closed copy", () => {
  const html = visible(renderToStaticMarkup(createElement(NetworkAdmission, null, content())));
  assert.equal(html, render(false));
  assert.ok(html.includes(hero));
  for (const text of ["ANYROUTE NETWORK · WE’RE GAUGING INTEREST", "THE PLAN", "When onboarding opens, an installer would connect your machine.", "When does it launch?", "Until then, outside hosts can’t join.", "When hosting opens"]) assert.ok(html.includes(text), text);
  assert.match(html, /href="#waitlist"[^>]*>.*?Join the waitlist/);
  assert.doesNotMatch(html, /OPEN FOR EARLY HOSTS|Join as a host|Host registration is open|Is it open\?/);
  auditNetworkWording(html);
});

test("explicit open status switches the hero, timeline, join and FAQ together", async () => {
  const open = await hostsOpen(async () => ({ ok: true, json: async () => ({ data: { network: { hosts_open: true } } }) }));
  const html = render(open);
  for (const text of ["ANYROUTE NETWORK · OPEN FOR EARLY HOSTS", "Hosting is open for early hosts running an approved build. Check your hardware, then join with one command.", "Not ready yet?", "How it works", "HOW IT WORKS", "Attestation checks the enclave", "Host registration is open.", "Is it open?", "Yes, for early hosts running an approved build (see the host policy at /api/v1/network/policy). New hosts start on probation."]) assert.ok(html.includes(text), text);
  assert.match(html, /href="#join"[^>]*>.*?Join as a host/);
  assert.match(html, /href="#readiness"[^>]*>.*?Check your hardware/);
  assert.match(html, /href="#waitlist">Join the waitlist\./);
  assert.ok(html.includes('id="join"')); assert.ok(html.includes('id="waitlist"'));
  assert.doesNotMatch(html, /isn’t open yet|outside hosts can’t join|would |When does it launch|not a live program|does not admit outside hosts/);
  auditNetworkWording(html);
});

test("failed, malformed, absent and non-boolean status all render closed", async () => {
  const fetchers = [
    async () => { throw new Error("unavailable"); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } }),
    ...[null, {}, { data: { network: { hosts_open: false } } }, { data: { network: { hosts_open: "true" } } }].map((body) => async () => ({ ok: true, json: async () => body })),
  ];
  for (const fetcher of fetchers) assert.equal(render(await hostsOpen(fetcher)), render(false));
});

test("both states retain disclosures, commands, waitlist and earnings limits", () => {
  for (const open of [false, true]) {
    const html = render(open);
    for (const text of ["AnyRoute’s router still reads requests in memory", "per token served", "USDG", "No amounts are promised", "sh deploy/seal/install.sh", "node join.mjs --key-file", "Developers and agents", "Join the waitlist"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /\b(?:demo|mock|simulated|placeholder|earn|yield|APY|returns|passive income)\b|local-build/i);
  }
  assert.ok(render(true).includes("Payouts to network hosts aren’t switched on yet"), "open copy states payouts are not on");
  assert.ok(!/open="[^"]*claimable on-chain/.test(fs.readFileSync("app/network/NetworkContent.jsx", "utf8")), "open copy must not promise claimable payouts");
  assert.throws(() => auditNetworkWording("Join the waitlist"), /admission wording/);
  assert.throws(() => auditNetworkWording("Hosting is open for early hosts running an approved build."), /waitlist wording/);
});

test("copy reserves both variants without animation; inactive links are inaccessible", () => {
  const css = fs.readFileSync("app/network/network.module.css", "utf8");
  assert.match(css, /\.copy \{[^}]*display: inline-grid/);
  assert.match(css, /\.copyState \{[^}]*grid-area: 1 \/ 1/);
  assert.doesNotMatch(css, /animation:|transition:/);
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(createElement(NetworkHostsContext.Provider, { value: open }, content()));
    assert.match(html, /aria-hidden="true" inert="" style="visibility:hidden"/);
  }
  const admission = fs.readFileSync("app/network/NetworkAdmission.jsx", "utf8"), join = fs.readFileSync("app/network/Join.jsx", "utf8");
  assert.equal((admission.match(/hostsOpen\(\)/g) || []).length, 1);
  assert.doesNotMatch(join, /hostsOpen|useEffect|useState/);
});
