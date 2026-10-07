// C131: this link is served by the router rather than exported by Next.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export function routerModelsFeedLink(value, root) {
  if (value !== '/api/v1/models/new.atom') return false;
  const api = JSON.parse(fs.readFileSync(path.join(root, 'openapi.json'), 'utf8'));
  const route = api.paths[value]?.get;
  assert(route, 'Missing public models feed API description');
  assert.deepEqual(route.security, [], 'The models feed must be public');
  assert(route.responses['200'].content['application/atom+xml'], 'The models feed must describe Atom output');
  return true;
}
