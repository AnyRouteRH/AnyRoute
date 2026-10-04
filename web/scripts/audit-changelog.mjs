import { validateChangelogWording } from './check-public-wording.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changelog, rssFeed, atomFeed, jsonFeed } from '../lib/changelog-feeds.js';

export function auditChangelog(root) {
  validateChangelogWording(changelog);
  const html = fs.readFileSync(path.join(root, 'changelog/index.html'), 'utf8');
  for (const entry of changelog) {
    assert.ok(html.includes(`id="${entry.id}"`), `Missing changelog permalink ${entry.id}`);
    assert.ok(new RegExp(`<time datetime="${entry.date}">`, 'i').test(html), `Missing changelog date ${entry.id}`);
    for (const link of entry.links) if (link.href.startsWith('/')) {
      const [route, anchor] = link.href.split('#');
      const page = fs.readFileSync(path.join(root, route, 'index.html'), 'utf8');
      if (anchor) assert.ok(page.includes(`id="${anchor}"`), `Missing changelog destination ${link.href}`);
    }
  }
  for (const [name, build] of [['rss.xml', rssFeed], ['atom.xml', atomFeed], ['index.json', jsonFeed]]) {
    assert.equal(fs.readFileSync(path.join(root, 'changelog', name), 'utf8'), build(), `Changelog ${name} differs from its source`);
  }
  console.log(`PASS: changelog; ${changelog.length} entries; 3 static feeds.`);
}
