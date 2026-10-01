import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { loadWhitepaper } from "../lib/whitepaper.js";
import { WHITEPAPER_BANNED_WORDS, whitepaperText } from "../lib/whitepaper-wording.js";

export function auditWhitepaper(root) {
  const html = fs.readFileSync(path.join(root, "whitepaper/index.html"), "utf8");
  const paper = loadWhitepaper();
  assert(html.includes("<title>AnyRoute Whitepaper — Anyroute</title>"), "Whitepaper title differs");
  assert(html.includes(paper.html), "Exported whitepaper differs from the root Markdown");
  assert.doesNotMatch(whitepaperText(paper.html), WHITEPAPER_BANNED_WORDS);
  for (const heading of paper.headings) {
    assert(html.includes(`id="${heading.id}"`), `Missing whitepaper heading ${heading.text}`);
  }
  for (const route of ["docs", "seal"]) {
    assert(fs.readFileSync(path.join(root, route, "index.html"), "utf8").includes('href="/whitepaper/"'), `Missing whitepaper link from /${route}`);
  }
}
