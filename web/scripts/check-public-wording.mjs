import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import entries from '../lib/changelog-data.js';
import { validateChangelog } from '../lib/changelog.js';
import { loadWhitepaper } from '../lib/whitepaper.js';
import { WHITEPAPER_BANNED_WORDS, whitepaperText } from './whitepaper-wording.mjs';

export function validateChangelogWording(entries) {
  validateChangelog(entries);
  for (const entry of entries) {
    const fail = message => { throw new Error(`Changelog ${entry.id}: ${message}`); };
    const copy = [entry.title, entry.summary, ...entry.links.map(link => link.label)].join(' ');
    if (/\b(?:demo|test|tested|mock|simulated|placeholder|earn|yield|APY|returns|passive income|decentralized|trustless|anonymous)\b|local[ -]build|zero[ -]knowledge|payout|slashing|email alert|sdk release|npm|pypi/i.test(copy)) fail('unavailable feature or banned wording');
  }
  return entries;
}

export function auditShippedWordingLists(root) {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
  const signatures = ['demo|test|tested|mock|simulated|placeholder', 'APY|returns|passive'];
  const scripts = walk(root).filter(file => /\.m?js$/.test(file));
  for (const file of scripts) {
    const source = fs.readFileSync(file, 'utf8');
    for (const signature of signatures) assert(!source.includes(signature), `Public wording list shipped in ${path.relative(root, file)}`);
  }
  console.log(`PASS: ${scripts.length} shipped scripts contain no public wording lists.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateChangelogWording(entries);
  const paper = loadWhitepaper();
  assert.doesNotMatch(paper.src, WHITEPAPER_BANNED_WORDS);
  assert.doesNotMatch(whitepaperText(paper.html), WHITEPAPER_BANNED_WORDS);
  console.log('PASS: changelog and whitepaper public wording.');
}
