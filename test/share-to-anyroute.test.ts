import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// D137: run the web's Node browser-API tests unchanged in both root gate environments.
test('phone sharing passes multipart, draft, auth-boundary and no-auto-send checks', () => {
  const output = execFileSync('node', ['--test', 'web/tests/share-to-anyroute.test.mjs'], {
    cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 15000,
  });
  expect(output).toMatch(/(?:# |ℹ )tests 15/);
  expect(output).toMatch(/(?:# |ℹ )pass 15/);
  expect(output).toMatch(/(?:# |ℹ )fail 0/);
});
