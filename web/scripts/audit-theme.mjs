// C126: verify every exported document, including error pages, before publishing.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { THEME_SCRIPT } from '../lib/theme.js';
export const THEME_HASH = `'sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`;
export function auditTheme(root) {
  const files = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.html')) files.push(file);
  } };
  walk(root);
  assert(files.length, 'No exported pages for appearance audit');
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const theme = scripts.filter(m => /\bid="anyroute-theme"/.test(m[1]));
    assert.equal(theme.length, 1, `One appearance script required: ${relative(root, file)}`);
    assert.equal(theme[0][2], THEME_SCRIPT, `Appearance script bytes changed: ${file}`);
    assert(theme[0].index < html.indexOf('</head>'), `Appearance script must run before body: ${file}`);
    // Mirrors src/lib/csp.ts's inline-script hash collection. The router adds this hash automatically.
    const hashes = scripts.filter(m => !/\bsrc\s*=/.test(m[1])).map(m => `'sha256-${createHash('sha256').update(m[2]).digest('base64')}'`);
    assert(hashes.includes(THEME_HASH), `Appearance script absent from CSP hash list: ${file}`);
  }
  console.log(`PASS: appearance script before body on ${files.length} exported HTML pages; CSP ${THEME_HASH}`);
  return files.map(file => relative(root, file));
}
