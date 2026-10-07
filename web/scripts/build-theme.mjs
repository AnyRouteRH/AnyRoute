// C126: offline HTML uses the identical startup script and palette, cached with the existing offline CSS.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEME_SCRIPT } from '../lib/theme.js';
export function buildOfflineTheme(root) {
  const html = join(root, 'offline.html');
  const source = readFileSync(html, 'utf8').replace(/<script id="anyroute-theme">[\s\S]*?<\/script>/g, '');
  writeFileSync(html, source.replace('</head>', `<script id="anyroute-theme">${THEME_SCRIPT}</script></head>`));
  const css = join(root, 'pwa/offline.css');
  const original = readFileSync(css, 'utf8').split('/* C126: offline palette */')[0];
  const palette = readFileSync(new URL('../app/theme-colors.css', import.meta.url), 'utf8');
  writeFileSync(css, original + '/* C126: offline palette */\n' + palette);
}
