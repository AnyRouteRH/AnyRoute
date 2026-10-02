import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = new URL('../public/zkapi/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['zkapi_browser.js', 'zkapi_browser_bg.wasm'];
fs.writeFileSync(new URL('provenance.json', root), JSON.stringify({
  source_revision: '045b444ea1b52538d1b40273c7cb6ed09468a052',
  package: 'zkapi-browser', version: '0.1.0', license: 'MIT OR Apache-2.0',
  rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
  cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(),
  wasm_bindgen: execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim(),
  protocol_lock_sha256: hash(fs.readFileSync(process.argv[2])),
  command: 'bash web/scripts/build-zkapi-wasm.sh',
  artifacts: Object.fromEntries(files.map(file => { const bytes = fs.readFileSync(new URL(file, root)); return [file, { bytes: bytes.length, sha256: hash(bytes) }]; })),
}, null, 2) + '\n');
