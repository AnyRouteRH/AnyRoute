import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export function auditZkapi(root) {
  const dir = path.join(root, 'zkapi');
  for (const file of ['index.html', 'prover-worker.js', 'zkapi_browser.js', 'zkapi_browser_bg.wasm', 'NOTICE.txt', 'provenance.json']) assert.ok(fs.existsSync(path.join(dir, file)), `Missing zkAPI asset ${file}`);
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'zkapi_browser_bg.wasm')).subarray(0, 4)], [0, 97, 115, 109]);
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, 'provenance.json')));
  assert.equal(provenance.source_revision, '045b444ea1b52538d1b40273c7cb6ed09468a052');
  for (const [file, artifact] of Object.entries(provenance.artifacts)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex'), artifact.sha256);
  assert.ok(!fs.readdirSync(dir).some(name => /\.(pk|vk)$/.test(name)), 'No proving keys in static output');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const file of walk(root).filter(f => f.endsWith('index.html') && f !== path.join(dir, 'index.html'))) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/src="(\/_next\/static\/[^"?]+\.js)"/g)) {
      const chunk = fs.readFileSync(path.join(root, match[1]), 'utf8');
      assert.ok(!chunk.includes('/zkapi/prover-worker.js') && !chunk.includes('zkapi_browser_bg.wasm'), `${file} includes the zkAPI loader`);
    }
  }
  return { route: '/zkapi/', wasmBytes: fs.statSync(path.join(dir, 'zkapi_browser_bg.wasm')).size };
}
