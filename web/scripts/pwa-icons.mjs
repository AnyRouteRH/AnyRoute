import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Reuse Next's installed image tooling; this script adds no package.
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('next/package.json'))('sharp');
const root = new URL('../', import.meta.url);
const css = await fs.readFile(new URL('app/globals.css', root), 'utf8');
const token = name => {
  const match = css.match(new RegExp(`--${name}:(#[a-fA-F0-9]{6})`));
  if (!match) throw new Error(`Missing colour token ${name}`);
  return match[1];
};
const ink = token('ink'), paper = token('paper');
const source = await fs.readFile(new URL('public/brand/anyroute-mark.svg', root), 'utf8');
// Fix the mark colour for an opaque paper tile; leave the original logo unchanged.
const mark = source.replace(/<style>[\s\S]*?<\/style>/, `<style>path{fill:${ink}}</style>`);
const dir = new URL('public/pwa/', root);
await fs.mkdir(dir, { recursive: true });
const icons = [];
for (const [size, purpose] of [[180, 'apple'], [192, 'any'], [512, 'any'], [192, 'maskable'], [512, 'maskable']]) {
  // All artwork lies inside the central 80% safe circle on maskable tiles.
  const width = Math.round(size * (purpose === 'maskable' ? .6 : .78));
  const image = await sharp(Buffer.from(mark)).resize({ width }).png().toBuffer();
  const name = purpose === 'apple' ? 'apple-touch-icon.png' : `icon-${size}${purpose === 'maskable' ? '-maskable' : ''}.png`;
  await sharp({ create: { width: size, height: size, channels: 4, background: paper } }).composite([{ input: image, gravity: 'centre' }]).png().toFile(fileURLToPath(new URL(name, dir)));
  if (purpose !== 'apple') icons.push({ src: `/pwa/${name}`, sizes: `${size}x${size}`, type: 'image/png', purpose });
}
await fs.writeFile(new URL('public/manifest.webmanifest', root), JSON.stringify({
  id: '/harness/', name: 'Anyroute', short_name: 'Anyroute', description: 'Install Anyroute on your phone or desktop',
  start_url: '/harness/', scope: '/', display: 'standalone', background_color: paper, theme_color: ink, icons,
}, null, 2) + '\n');
