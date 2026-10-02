import {TASKS} from '../lib/site-map.js';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Static checks on how the page is wired. The page must work at the router's onion address, so every request it makes
// has to be relative; the one-time key must never reach a longer-lived store; and the page has to be linked.
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const SOURCES = ["lib/purse.js", "lib/purse-store.js", "lib/purse-file.js", "lib/blind-rsa.js", "components/PrivatePurse.jsx"];
const IMPOSTOR = "0x57eb1e4514e6c97baa1732e67b6845ec51943e6b";

test("every request goes through api(), and every path is under /api/v1/ with no host", () => {
  for (const file of SOURCES) {
    const src = read(file);
    assert.doesNotMatch(src, /\bfetch\s*\(/, `${file} calls fetch directly`);
    assert.doesNotMatch(src, /\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b/, `${file} opens another kind of connection`);
    for (const m of src.matchAll(/\bapi\(\s*([`"'])([^`"']*)\1/g)) assert.match(m[2], /^\/api\/v1\//, `${file}: api(${m[2]})`);
  }
  const paths = [...read("lib/purse.js").matchAll(/api\(\s*[`"'](\/api\/v1\/[^`"']*)/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, "{}"));
  for (const p of ["/api/v1/keys", "/api/v1/credits", "/api/v1/credits/deposit-tx", "/api/v1/blind/keys", "/api/v1/blind/purchase", "/api/v1/keys/{}", "/api/v1/status", "/api/v1/escrow", "/api/v1/escrow/anyr/price", "/api/v1/auth/wallet", "/api/v1/auth/wallet/challenge", "/api/v1/escrow/deposits", "/api/v1/key"])
    assert.ok(paths.includes(p), `expected the flow to use ${p}; found ${paths.join(", ")}`);
});

test("the page names no host: no absolute URL in its code, and the docs link is relative", () => {
  for (const file of SOURCES) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const urls = [...code.matchAll(/https?:\/\/[^\s"'`)]*/g)].map((m) => m[0]);
    assert.deepEqual(urls.filter((u) => u !== "http://" && !/^http:\/\/\\/.test(u)), [], `${file} names a host`);
  }
  assert.match(read("components/PrivatePurse.jsx"), /href="\/docs\/#private-tokens"/);
  assert.match(read("app/docs/page.jsx"), /id="private-tokens"/);
});

test("the one-time key is never written to localStorage, IndexedDB, cookies or the URL", () => {
  for (const file of SOURCES) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /localStorage|document\.cookie|location\.(hash|search)|history\.(push|replace)State/, file);
  }
  const store = read("lib/purse-store.js");
  assert.match(store, /sessionStorage/);
  // the purse only ever stores tokens and pending purchases, never the key
  assert.doesNotMatch(store.slice(store.indexOf("class Purse")), /secret|recoveryKey|holder/i);
});

test("the wrong $ANYR contract appears nowhere, and the right one is checked against", () => {
  for (const file of [...SOURCES, "app/tokens/page.jsx", "app/docs/page.jsx", "tests/purse-flow.test.mjs", "tests/purse-helpers.mjs"]) assert.ok(!read(file).toLowerCase().includes(IMPOSTOR), file);
  assert.match(read("components/PrivatePurse.jsx"), /officialAnyr: ANYR_CA/);
  assert.match(read("components/ContractAddress.jsx"), /0xa4dDF89A40A35264E9D7F896a1ef01C59b1e977a/);
});

test("the page is linked from the header and the footer and is part of the build audit", () => {
  assert.match(read("components/UI.jsx"), /<DesktopGroups path=\{path\}\/>/);
  assert.ok(TASKS.some(task => task.id === "tokens" && task.href === "/tokens/"));
  assert.match(read("components/Footer.jsx"), /TASKS.filter/);
  assert.match(read("scripts/audit-build.mjs"), /'\/tokens\/'/);
  const page = read("app/tokens/page.jsx");
  assert.match(page, /export const metadata/);
  assert.match(page, /<PrivatePurse \/>/);
});

test("public wording on the page and in the docs section avoids the words the site does not use", () => {
  const banned = /\b(demo|mock|mocked|simulated|placeholder)\b|\btest(ed|ing)?\b/i;
  const docs = read("app/docs/page.jsx");
  const section = docs.slice(docs.indexOf('<h2 id="private-tokens">'), docs.indexOf('<h2 id="key-log">'));
  assert.ok(section.length > 1500);
  for (const [name, text] of [["page", read("app/tokens/page.jsx")], ["component", read("components/PrivatePurse.jsx")], ["docs section", section]]) {
    const visible = text.replace(/import .*$/gm, "").replace(/\.test\(/g, "(").replace(/\bplaceholder=/g, "");
    assert.doesNotMatch(visible, banned, name);
    assert.doesNotMatch(visible, /\b(yield|APY|invest\w*|expected returns?|returns on|profit|price target|guarantee\w*|untraceable|no logs)\b/i, name);
    assert.doesNotMatch(visible, /cannot read|can’t read|can't read/i, name);
  }
});
