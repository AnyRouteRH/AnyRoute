import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('Docker web build forwards the public wallet settings with disabled defaults', () => {
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const stage = dockerfile.split(' AS web\n')[1].split('\nFROM ')[0];
  const settings = { NEXT_PUBLIC_ZKAPI_ENABLED: 'false', NEXT_PUBLIC_ZKAPI_MANIFEST_URL: '', NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256: '' };
  for (const [name, value] of Object.entries(settings)) {
    const declaration = `ARG ${name}="${value}"`;
    assert.ok(stage.includes(declaration));
    assert.ok(stage.indexOf(declaration) < stage.indexOf('RUN pnpm build'));
    assert.match(stage, new RegExp(`^ENV .*${name}=\\$${name}(?: |$)`, 'm'));
    assert.ok(stage.indexOf(`${name}=$${name}`) < stage.indexOf('RUN pnpm build'));
  }
  const protocol = new URL('../lib/zkapi/protocol.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import { ENABLED, MANIFEST_URL, MANIFEST_SHA256 } from ${JSON.stringify(protocol)}; console.log(JSON.stringify({ ENABLED, MANIFEST_URL, MANIFEST_SHA256 }));`], { env: { ...process.env, ...settings }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { ENABLED: false, MANIFEST_URL: '', MANIFEST_SHA256: '' });
});
