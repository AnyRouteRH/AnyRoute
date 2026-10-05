import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentMonth, evidenceHref, laneLabel, laneReportPath, laneReportRangeError, laneSegments, monthRange, percent, provenSentence, readLaneReport } from '../lib/lane-report.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const now = new Date('2026-10-04T12:00:00Z');
const report = {
  type: 'anyroute.lane-report.v1', scope: 'account', range: { from: '2026-09-01', to: '2026-09-30', so_far: false },
  totals: { calls: 9, spend: '1.2' },
  lanes: [
    { lane: 'public', proven: false, calls: 3, spend: '0.3', share_of_calls: 0.3333, share_of_spend: 0.25 },
    { lane: 'attested', proven: true, calls: 4, spend: '0.8', share_of_calls: 0.4444, share_of_spend: 0.6667 },
    { lane: 'unlinkable', proven: true, calls: 0, spend: '0', share_of_calls: 0, share_of_spend: 0 },
    { lane: null, proven: false, calls: 2, spend: '0.1', share_of_calls: 0.2222, share_of_spend: 0.0833 },
  ],
  proven: { lanes: ['attested', 'unlinkable'], calls: 4, spend: '0.8', share_of_calls: 0.4444, share_of_spend: 0.6667 },
  providers: [{ lane: 'attested', provider: 'alpha', model: 'meta-llama/llama-3.3-70b-instruct', calls: 4, spend: '0.8', evidence_url: '/verify/?p=alpha' }],
};

test('lane report paths carry UTC dates; a month becomes its first to last day, or to today while it runs', () => {
  const url = new URL(laneReportPath({ from: '2026-09-01', to: '2026-09-30' }), 'https://router.example');
  assert.equal(url.pathname, '/api/v1/lane-report');
  assert.deepEqual(Object.fromEntries(url.searchParams), { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(currentMonth(now), '2026-10');
  assert.deepEqual(monthRange('2026-10', now), { from: '2026-10-01', to: '2026-10-04' });
  assert.deepEqual(monthRange('2026-09', now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(monthRange('2024-02', now), { from: '2024-02-01', to: '2024-02-29' });
  assert.equal(laneReportRangeError(monthRange('2026-08', now), 31, now), '');
});

test('ranges are checked before a request: real dates, order, not in the future, at most 31 days', () => {
  assert.match(laneReportRangeError({ from: '', to: '2026-10-01' }, 31, now), /start and an end/);
  assert.match(laneReportRangeError({ from: '2026-02-30', to: '2026-03-01' }, 31, now), /start and an end/);
  assert.match(laneReportRangeError({ from: '2026-10-02', to: '2026-10-01' }, 31, now), /on or after/);
  assert.match(laneReportRangeError({ from: '2026-10-05', to: '2026-10-06' }, 31, now), /future/);
  assert.equal(laneReportRangeError({ from: '2026-08-01', to: '2026-08-31' }, 31, now), '');
  assert.equal(laneReportRangeError({ from: '2026-09-01', to: '2026-10-02' }, 31, now), 'A lane report covers at most 31 days. This range has 32.');
});

test('shares read as percentages, the bar shows only lanes with a share, and the proven share is one sentence', () => {
  assert.deepEqual([percent(0.3333), percent(1), percent(0), percent(0.0417), percent(null)], ['33.3%', '100%', '0%', '4.2%', '–']);
  assert.deepEqual(laneSegments(report, 'calls').map(s => [s.tone, s.share, s.proven]), [['public', 0.3333, false], ['attested', 0.4444, true], ['none', 0.2222, false]]);
  assert.deepEqual(laneSegments(report, 'spend').map(s => s.text), ['Public 25%', 'Attested 66.7%', 'Lane not recorded 8.3%']);
  assert.equal(provenSentence(report), '44.4% of calls and 66.7% of spend ran on proven hardware.');
  assert.equal(provenSentence({ ...report, proven: { ...report.proven, share_of_spend: null } }), '44.4% of calls ran on proven hardware.');
  assert.equal(provenSentence({ ...report, totals: { calls: 0, spend: '0' } }), 'No calls in this range.');
  assert.deepEqual([laneLabel('public'), laneLabel('attested'), laneLabel('unlinkable'), laneLabel(null)], ['Public', 'Attested', 'Unlinkable', 'Lane not recorded']);
});

test('evidence links stay on this site, and a response is checked before it is shown', () => {
  assert.equal(evidenceHref('alpha'), '/verify/?p=alpha');
  assert.equal(evidenceHref('a b/c'), '/verify/?p=a%20b%2Fc');
  assert.equal(readLaneReport({ data: report }), report);
  for (const bad of [null, {}, { data: { ...report, type: 'anyroute.statement.v1' } }, { data: { ...report, providers: null } }]) assert.throws(() => readLaneReport(bad), /could not be read/);
});

test('the dashboard shows the card on Statements, before the proof pack, and only after the router answers', () => {
  const dashboard = read('components/Dashboard.jsx');
  assert.match(dashboard, /import AccountLaneReport from "\.\/account\/AccountLaneReport";/);
  assert.match(dashboard, /\{tab === "Statements" && apiKey && <AccountLaneReport [^>]*apiKey=\{apiKey\}\/>\}/);
  assert.ok(dashboard.indexOf('<AccountLaneReport') < dashboard.indexOf('<AccountProofPack'));
  const card = read('components/account/AccountLaneReport.jsx');
  assert.match(card, /if \(!shown\) return null;/);
  assert.match(card, /e\.status === 404 \|\| e\.status === 403/);
  assert.match(card, /Where your calls ran/);
  assert.match(card, /evidenceHref\(row\.provider\)/);
  assert.match(card, /PROOF_TIME_HREF/);
  const css = read('components/account/LaneReport.module.css');
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /content:attr\(data-label\)/);
});

test('copy names lanes and proven hardware, and stays plain', () => {
  const files = ['components/account/AccountLaneReport.jsx', 'lib/lane-report.js'];
  const visible = files.map(read).flatMap(src => [...src.matchAll(/>([^<>{}]+)</g), ...src.matchAll(/'([^'\n]{12,})'/g), ...src.matchAll(/`([^`\n]{12,})`/g)].map(m => m[1])).join(' ');
  assert.match(visible, /proven hardware/);
  assert.doesNotMatch(visible, /\b(?:demo|test|tested|local|mock|simulated|placeholder|fixture|earn|yield|APY|private|x402)\b|no logs|can.t read your prompt/i);
});
