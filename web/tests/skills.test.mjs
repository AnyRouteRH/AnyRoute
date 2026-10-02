import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ACCOUNT_SECTIONS } from '../lib/site-map.js';
import { LEVEL_LABEL, SKILL_LEVELS, findingLine, formatPrice, installLabel, skillsQuery } from '../lib/skills.js';

const spec = JSON.parse(fs.readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
const dashboard = fs.readFileSync(new URL('../components/Dashboard.jsx', import.meta.url), 'utf8');
const tab = fs.readFileSync(new URL('../components/features/Skills.jsx', import.meta.url), 'utf8');

test('scan levels are text labels and the query only carries known levels', () => {
  assert.deepEqual(SKILL_LEVELS, ['trusted', 'caution', 'dangerous']);
  assert.deepEqual(Object.values(LEVEL_LABEL), ['Trusted', 'Caution', 'Dangerous']);
  assert.equal(skillsQuery({}), '');
  assert.equal(skillsQuery({ q: ' pdf ', level: 'trusted' }), '?q=pdf&level=trusted');
  assert.equal(skillsQuery({ level: 'unsafe' }), '');
  assert.equal(formatPrice(0), 'Free');
  assert.equal(formatPrice(2), '$2.00');
  assert.equal(findingLine({ severity: 'critical', rule: 'exfil.env_to_network', file: 'scripts/warm.sh', line: 2, excerpt: 'curl -d "$(env)"' }), 'CRITICAL exfil.env_to_network scripts/warm.sh:2 curl -d "$(env)"');
  assert.equal(installLabel({ level: 'dangerous' }, true), 'Blocked: scanned as dangerous');
  assert.match(installLabel({ level: 'trusted', price_usd: 2 }, true), /90% to the author/);
});

test('the dashboard has a Skills tab that says scanned, not guaranteed, with no new colours', () => {
  assert.ok(ACCOUNT_SECTIONS.some(section => section.title === 'Skills' && section.hash === 'skills'));
  assert.match(dashboard, /if \(tab === "Skills"\) return <Skills/);
  assert.match(tab, /Scanned, not guaranteed/);
  assert.doesNotMatch(tab, /#[0-9a-f]{3,6}\b|style=\{\{\s*(color|background)/i);
  assert.doesNotMatch(tab, /—/);
});

test('the OpenAPI document covers the Skills Hub', () => {
  assert.ok(spec.tags.some((t) => t.name === 'Skills'));
  for (const [path, method] of [['/api/v1/skills', 'get'], ['/api/v1/skills/{id}', 'get'], ['/api/v1/skills/{id}', 'patch'], ['/api/v1/skills/{id}/download', 'get'], ['/api/v1/skills/import', 'post'], ['/api/v1/skills/{id}/install', 'post'], ['/api/v1/skills/{id}/revoke', 'post']]) {
    const op = spec.paths[path]?.[method];
    assert.ok(op, `${method.toUpperCase()} ${path}`);
    assert.deepEqual(op.tags, ['Skills']);
  }
  assert.equal(spec.paths['/api/v1/skills'].get.security, undefined, 'the registry is public');
  assert.deepEqual(spec.components.schemas.SkillScanReport.properties.level.enum, ['trusted', 'caution', 'dangerous']);
  assert.match(spec.tags.find((t) => t.name === 'Skills').description, /Scanned, not guaranteed/);
});
