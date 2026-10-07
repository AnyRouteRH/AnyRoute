// C126: the real site policy includes the exact startup script, including on the offline page.
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siteCsp } from '../src/lib/csp.ts';
import { THEME_SCRIPT } from '../web/lib/theme.js';

test('site CSP permits the appearance startup by exact hash without arbitrary inline scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyroute-theme-csp-'));
  try {
    mkdirSync(join(root, 'docs'));
    const html = `<html><head><script id="anyroute-theme">${THEME_SCRIPT}</script></head><body></body></html>`;
    for (const file of ['index.html', 'docs/index.html', 'offline.html']) writeFileSync(join(root, file), html);
    const policy = siteCsp(root);
    const hash = `'sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`;
    expect(policy).toContain(`script-src 'self' ${hash};`);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
