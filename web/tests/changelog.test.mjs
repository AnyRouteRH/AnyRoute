import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { CHANGELOG_TAGS, COMMIT_URL, filterChangelog, groupChangelog, sortChangelog, validateChangelog } from '../lib/changelog.js';
import { changelog, rssFeed, atomFeed, jsonFeed, escapeXml } from '../lib/changelog-feeds.js';
import { TASKS, menuTasks } from '../lib/site-map.js';

const sample = () => ({ id: 'sample-change', date: '2026-09-30', title: 'Read receipts', summary: 'Inspect signed receipts.', tags: ['verify'], links: [{ label: 'Open page', href: '/verify/' }, { label: 'View commit', href: 'https://github.com/AnyRouteRH/AnyRoute/commit/' + 'a'.repeat(40) }] });

test('entries have unique stable ids, UTC days, supported tags and site plus full commit links', () => {
  assert.equal(validateChangelog(changelog), changelog);
  assert.deepEqual(CHANGELOG_TAGS, ['chat', 'agents', 'network', 'build', 'verify', 'privacy', 'fix']);
  for (const entry of changelog) {
    assert.ok(existsSync(new URL('../app' + entry.links.find(link => link.href.startsWith('/')).href.split('#')[0] + 'page.jsx', import.meta.url)));
    assert.ok(entry.title.length <= 80);
    assert.ok(entry.summary.length <= 400);
  }
});

test('schema rejects invalid dates, ids, tags, copy and incomplete or unsafe links', () => {
  for (const changes of [
    { id: 'Bad id' }, { date: '2026-02-30' }, { date: '2026-13-01' }, { date: '2026-9-01' },
    { date: '2026-09-01T12:00:00Z' }, { title: '' }, { summary: ' ' }, { tags: ['other'] },
    { tags: ['verify', 'verify'] }, { links: [] }, { links: [{ label: 'Read', href: '/verify/' }] },
    { links: [{ label: 'Read', href: 'javascript:alert(1)' }] },
    { links: [{ label: 'Commit', href: 'https://github.com/AnyRouteRH/AnyRoute/commit/abc1234' }] },
  ]) assert.throws(() => validateChangelog([{ ...sample(), ...changes }]));
  assert.throws(() => validateChangelog([sample(), sample()]));
  assert.throws(() => validateChangelog([]));
});

test('public copy excludes banned words and features not switched on', () => {
  for (const summary of ['demo', 'tested', 'mock', 'simulated', 'placeholder', 'local-build', 'earn', 'yield', 'APY', 'returns', 'passive income', 'decentralized', 'trustless', 'zero-knowledge', 'anonymous', 'host payouts', 'slashing', 'email alerts', 'SDK releases on npm']) {
    assert.throws(() => validateChangelog([{ ...sample(), summary }]));
  }
  const encrypted = changelog.find(entry => entry.id === 'encrypted-chat');
  assert.match(encrypted.summary, /on this path/);
  assert.match(encrypted.summary, /Ordinary chat paths still let the router read request text in memory/);
  assert.match(changelog.find(entry => entry.id === 'sealed-agents').summary, /no sealed agent is registered/);
});

test('every entry maps to commits in git history and uses their newest UTC committer day', t => {
  const result = spawnSync('git', ['log', 'HEAD', '--format=%H %ct'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  if (result.error?.code === 'ENOENT' || /not a git repository/i.test(result.stderr || '')) return t.skip('Git history is unavailable');
  // CI checks out a shallow clone; full history is checked wherever it exists (local gates).
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  if (shallow.stdout?.trim() === 'true') return t.skip('Shallow clone: commit history is incomplete');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const commits = new Map(result.stdout.trim().split('\n').map(line => line.split(' ')));
  for (const entry of changelog) {
    const days = entry.links.filter(link => COMMIT_URL.test(link.href)).map(link => {
      const sha = COMMIT_URL.exec(link.href)[1];
      assert.ok(commits.has(sha), `${entry.id}: missing ${sha}`);
      return new Date(Number(commits.get(sha)) * 1000).toISOString().slice(0, 10);
    });
    assert.equal(entry.date, days.sort().at(-1), entry.id);
  }
});

test('history includes earlier shipped feature groups across August, September and October', () => {
  assert.equal(changelog.at(-1).date, '2026-08-24');
  assert.deepEqual(groupChangelog(changelog).map(group => group.month), ['2026-10', '2026-09', '2026-08']);
  for (const id of ['prepaid-credits', 'streamed-chat-api', 'signed-receipts', 'public-model-pages',
    'account-dashboard', 'stock-escrow', 'anyr-escrow', 'x402-call-payments', 'harness-chat',
    'model-arena', 'public-key-log', 'seal-protocol-pages', 'attested-provider-checks',
    'unlinkable-tor-lane', 'private-token-wallet', 'ask-your-files', 'data-storage-inventory',
    'saved-routing-policies', 'versioned-presets', 'character-cards', 'evaluate-models',
    'browser-batches', 'skill-scan-reports', 'team-account-controls', 'spend-watch',
    'public-provider-records', 'proof-freshness', 'lane-status-page']) {
    assert.ok(changelog.some(entry => entry.id === id), `Missing history group: ${id}`);
  }
  for (const query of ['signed receipts', 'Tor', 'PDF', 'passkeys', 'presets']) {
    assert.ok(filterChangelog(changelog, { query }).length > 0, `Missing searchable history: ${query}`);
  }
});

test('filter combines tags and case-insensitive words, with newest dates first', () => {
  const entries = [{ ...sample(), id: 'older', date: '2026-09-01' }, { ...sample(), id: 'newer', date: '2026-10-01' }, { ...sample(), id: 'chat', title: 'Speak aloud', tags: ['chat'] }];
  assert.deepEqual(filterChangelog(entries).map(entry => entry.id), ['newer', 'chat', 'older']);
  assert.deepEqual(filterChangelog(entries, { tag: 'verify', query: ' READ   SIGNED ' }).map(entry => entry.id), ['newer', 'older']);
  assert.equal(filterChangelog(entries, { tag: 'chat', query: 'read' }).length, 0);
  assert.equal(filterChangelog(entries, { query: 'no match' }).length, 0);
  assert.equal(filterChangelog(entries, { query: '2026-10' }).length, 1);
  assert.equal(entries[0].id, 'older', 'sorting must not mutate the source');
});

test('months group newest first with stable UTC labels and ordering within a day', () => {
  const groups = groupChangelog([{ ...sample(), id: 'z' }, { ...sample(), id: 'a' }, { ...sample(), id: 'october', date: '2026-10-01' }]);
  assert.deepEqual(groups.map(group => group.label), ['October 2026', 'September 2026']);
  assert.deepEqual(groups[1].entries.map(entry => entry.id), ['a', 'z']);
  assert.deepEqual(groupChangelog([]), []);
});

test('XML escapes ampersands, angle brackets and both kinds of quotes in copy and attributes', () => {
  assert.equal(escapeXml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
  const entry = { ...sample(), title: 'Read A & B <now>', summary: 'Use "quotes" & <marks> safely.', links: sample().links.map(link => ({ ...link, label: 'Read "A" & \'B\'' })) };
  const rss = rssFeed([entry]), atom = atomFeed([entry]);
  for (const xml of [rss, atom]) {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('Read A &amp; B &lt;now&gt;'));
    assert.ok(xml.includes('Use &quot;quotes&quot; &amp; &lt;marks&gt; safely.'));
    assert.ok(!xml.includes('<marks>'));
  }
  assert.ok(atom.includes('title="Read &quot;A&quot; &amp; &apos;B&apos;"'));
});

test('all feeds use the same ordered entries, permalinks, dates, categories and summaries', () => {
  const rss = rssFeed(), atom = atomFeed(), json = JSON.parse(jsonFeed());
  assert.equal((rss.match(/<item>/g) || []).length, changelog.length);
  assert.equal((atom.match(/<entry>/g) || []).length, changelog.length);
  assert.deepEqual(json.entries.map(({ url, ...entry }) => entry), changelog);
  assert.ok(rssFeed([sample()]).includes('<lastBuildDate>Wed, 30 Sep 2026 00:00:00 GMT</lastBuildDate>'));
  for (const entry of changelog) {
    const url = `https://anyroute.tech/changelog/#${entry.id}`;
    assert.ok(rss.includes(`<guid isPermaLink="true">${url}</guid>`));
    assert.ok(atom.includes(`<id>${url}</id>`));
    assert.ok(atom.includes(`<published>${entry.date}T00:00:00Z</published>`));
    assert.ok(rss.includes(`<description>${escapeXml(entry.summary)}</description>`));
    for (const tag of entry.tags) assert.ok(rss.includes(`<category>${tag}</category>`) && atom.includes(`<category term="${tag}"/>`));
  }
  assert.equal(jsonFeed([...changelog].reverse()), jsonFeed(), 'output is deterministic');
});

test('feed route handlers opt into static export and serve the generated content', async () => {
  for (const [name, type, build] of [['rss.xml', 'application/rss+xml', rssFeed], ['atom.xml', 'application/atom+xml', atomFeed], ['index.json', 'application/json', jsonFeed]]) {
    const route = await import(`../app/changelog/${name}/route.js`);
    assert.equal(route.dynamic, 'force-static');
    const response = route.GET();
    assert.equal(response.headers.get('content-type'), type + '; charset=utf-8');
    assert.equal(await response.text(), build());
  }
});

test('the shared map exposes the changelog in Learn, search and the footer menu', () => {
  const item = TASKS.find(task => task.id === 'changelog');
  assert.equal(item.title, "See what's new");
  assert.equal(item.href, '/changelog/');
  assert.ok(menuTasks('learn').includes(item));
  assert.ok(menuTasks('learn').length <= 9);
  const footer = readFileSync(new URL('../components/Footer.jsx', import.meta.url), 'utf8');
  assert.match(footer, /TASKS\.filter\(task=>task\.group===group\.id&&task\.menu\)/);
});

test('page includes labelled keyboard controls, result announcements, anchors and feeds', () => {
  const page = readFileSync(new URL('../app/changelog/page.jsx', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../app/changelog/Changelog.jsx', import.meta.url), 'utf8');
  for (const url of ['rss.xml', 'atom.xml', 'index.json']) assert.ok(page.includes('/changelog/' + url));
  assert.match(ui, /<label[^>]*>Search changes<input type="search"/);
  assert.match(ui, /<label>Filter by tag<select/);
  assert.match(ui, /role="status"/);
  assert.match(ui, /id=\{entry\.id\}/);
  assert.match(ui, /href=\{`#\$\{entry\.id\}`\}/);
  assert.match(ui, /Clear filters/);
  assert.equal(sortChangelog(changelog).length, changelog.length);
});
