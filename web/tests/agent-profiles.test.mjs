import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profilePayload, directoryPath, profileLink, safeHomepage } from '../lib/agent-profiles.js';
test('explicit publication selection stays empty unless selected, and homepage schemes are safe', () => {
  const payload = profilePayload({ name: ' Agent ', description: ' Search ', homepage: '', tags: 'search, tools, search', show: [], claims: '' });
  assert.deepEqual(payload, { name: 'Agent', description: 'Search', capabilities: ['search', 'tools'], show: [], certificate_claims: [] });
  assert.equal(safeHomepage('javascript:alert(1)'), null);
  assert.equal(safeHomepage('https://name:secret@example.com'), null);
  assert.equal(safeHomepage('https://example.com/agent'), 'https://example.com/agent');
});
test('directory tag/cursor and profile query values are encoded', () => {
  assert.equal(directoryPath('a&b', 'abc'), '/api/v1/agents/profiles?tag=a%26b&cursor=abc');
  assert.equal(profileLink({ anyroute: { id: 'a?b' } }), '/agents/profile/?id=a%3Fb');
});
test('OpenAPI describes opt-in fields, owner authentication and public discovery', () => {
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  const owned = spec.paths['/api/v1/agents/{key_hash}/profile'];
  for (const method of ['get', 'put', 'delete']) assert.deepEqual(owned[method].security, [{ BearerAuth: [] }]);
  const schema = owned.put.requestBody.content['application/json'].schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.show.items.enum, ['spending_caps', 'ask_first', 'kill_switch']);
  assert.ok(!schema.properties.certificates);
  const card = spec.paths['/api/v1/agents/profiles/{slug}'].get;
  assert.deepEqual(card.security, []); assert.match(card.description, /defaults false/);
  assert.equal(card.responses['200'].content['application/json'].schema.properties.anyroute.properties.status.properties.attested.const, 'unavailable');
  assert.deepEqual(spec.paths['/api/v1/agents/profiles'].get.parameters.map(p => p.name), ['tag', 'cursor', 'limit']);
});
