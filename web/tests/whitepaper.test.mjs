import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWhitepaper, resolveWhitepaperHref } from "../lib/whitepaper.js";
import { listDocs, REPO_URL } from "../lib/seal-spec.js";
import { parseBlocks, plainText } from "../lib/spec-markdown.js";
import { WHITEPAPER_BANNED_WORDS, whitepaperText } from "../scripts/whitepaper-wording.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const paper = loadWhitepaper(root);
// Render the real page using the existing Bun JSX toolchain, including PageFrame.
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
const { default: WhitepaperPage, metadata } = await import("../app/whitepaper/page.jsx");
hook.deregister();
const html = renderToStaticMarkup(createElement(WhitepaperPage));

test("whitepaper page renders the full root document with the long-form frame", () => {
  assert.equal(metadata.title, "Whitepaper — Anyroute");
  assert.match(html, /<h1>AnyRoute Whitepaper<\/h1>/);
  assert.match(html, /side-layout/);
  assert.match(html, /On this page/);
  assert(html.includes(paper.html));
  assert.match(html, /<header/);
  assert.match(html, /<footer/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre/);
  assert.equal((html.match(/href="\/whitepaper\/"/g) || []).length, 2, "Header and footer link to paper");
});

test("all section headings stay in sync and the twelve main sections have navigation links", () => {
  const sourceHeadings = parseBlocks(paper.src).filter(block => block.type === "heading" && block.level > 1).map(block => plainText(block.text));
  assert.deepEqual(paper.headings.map(heading => heading.text), sourceHeadings);
  const sections = paper.headings.filter(heading => heading.level === 2);
  assert.equal(sections.length, 12);
  sections.forEach((heading, index) => {
    assert(heading.text.startsWith(`${index + 1}. `));
    assert(html.includes(`href="#${heading.id}"`));
  });
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)[1];
  const rendered = [...article.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<a class="heading-anchor"/g)].map(([, level, id, text]) => ({ level: Number(level), id, text: whitepaperText(text).trim() }));
  assert.deepEqual(rendered, paper.headings);
});

test("whitepaper contains no banned public wording and stays within the requested length", () => {
  assert.doesNotMatch(paper.src, WHITEPAPER_BANNED_WORDS);
  assert.doesNotMatch(whitepaperText(paper.html), WHITEPAPER_BANNED_WORDS);
  assert.doesNotMatch(metadata.description, WHITEPAPER_BANNED_WORDS);
  const words = paper.src.trim().split(/\s+/).length;
  assert(words >= 5000 && words <= 8000, `Whitepaper has ${words} whitespace-separated words`);
});

test("repository references exist and site references are rewritten to export routes", () => {
  const docs = listDocs(path.join(root, "spec"));
  assert.deepEqual(resolveWhitepaperHref("spec/0001-attestation.md", docs), { href: "/spec/0001-attestation/", external: false });
  assert.deepEqual(resolveWhitepaperHref("web/app/keep/page.jsx", docs), { href: "/keep/", external: false });
  assert.deepEqual(resolveWhitepaperHref("https://anyroute.tech/docs/#e2ee-phala", docs), { href: "/docs/#e2ee-phala", external: false });
  assert.deepEqual(resolveWhitepaperHref("src/api/chat.ts", docs), { href: `${REPO_URL}/blob/main/src/api/chat.ts`, external: true });
  assert.equal(resolveWhitepaperHref("../outside.md", docs), null);
  for (const [, href] of paper.src.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|#|mailto:)/.test(href)) continue;
    assert(fs.existsSync(path.join(root, href.split("#")[0])), `Missing source reference ${href}`);
  }
  for (const [, href] of paper.html.matchAll(/href="([^"]+)"/g)) {
    assert(/^(#|\/|https:\/\/)/.test(href), `Unresolved reference ${href}`);
    if (href.startsWith("#")) assert(paper.html.includes(`id="${href.slice(1)}"`));
  }
  for (const page of ["docs", "seal"]) {
    assert(fs.readFileSync(path.join(root, `web/app/${page}/page.jsx`), "utf8").includes('href="/whitepaper/"'));
  }
});

test("privacy and activation qualifications remain explicit", () => {
  for (const phrase of [
    "On ordinary paths the router reads request text in memory",
    "Encryption terminates at the gateway enclave",
    "GPU evidence is not bound into the CPU quote",
    "no network host payouts are being made",
    "host-bond slashing is not switched on yet",
    "not zero-knowledge proofs and are not anonymous credentials",
    "There is no on-chain enforcement of the rulebook",
    "not an offer or investment advice",
  ]) assert(paper.src.includes(phrase), `Missing qualification: ${phrase}`);
});


test("whitepaper covers current discovery, hosting, statistics and agreement trust", () => {
  for (const phrase of [
    "6.7 Live network statistics", "GET /api/v1/network/stats", "100,000-token", "No data yet",
    "7.6 Opt-in profiles and directory", "/agents/directory", "Random slugs never expose the key hash",
    "A2A-style card JSON", "anyroute_agent_directory", "latest valid track-record certificate",
    "7.7 Available sealed agent hosting", "deploy/agents/sealed", "Sealed · attested",
    "no sealed agent is registered at anyroute.tech yet", "Approval details pass through Telegram",
    "7.8 Agreements between agents", "Automatic jury rulings are switched on",
    "Sourcify-verified", "30 days unruled", "50/50",
    "router controls jury signing keys", "not model execution, attestation or verdict correctness",
    "Panel decisions remain trusted", "Both parties, the router and jury models can read evidence",
  ]) assert(paper.src.includes(phrase), `Missing current state or limit: ${phrase}`);
  const next = paper.src.split("## 11. What's next")[1].split('## 12.')[0];
  for (const phrase of ['switching on x402 per-call payments', 'agent wallets with on-chain rules', 'GPU hosts on the network', 'network payouts']) assert(next.includes(phrase), phrase);
  assert.doesNotMatch(paper.src, /sealed agent hosting[^.]*is (?:also )?next|Agreements between agents[^.]*are next/i);
});
