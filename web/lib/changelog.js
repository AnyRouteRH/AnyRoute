export const CHANGELOG_TAGS = ['chat', 'agents', 'network', 'build', 'verify', 'privacy', 'fix'];
export const CHANGELOG_URL = 'https://anyroute.tech/changelog/';
export const COMMIT_URL = /^https:\/\/github\.com\/AnyRouteRH\/AnyRoute\/commit\/([a-f0-9]{40})$/;

export function validateChangelog(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Changelog needs entries');
  const ids = new Set();
  for (const entry of entries) {
    const fail = message => { throw new Error(`Changelog ${entry.id}: ${message}`); };
    if (typeof entry.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || ids.has(entry.id)) fail('invalid or repeated id');
    ids.add(entry.id);
    if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(Date.parse(entry.date)) || new Date(entry.date).toISOString().slice(0, 10) !== entry.date) fail('invalid UTC day');
    if (typeof entry.title !== 'string' || !entry.title.trim() || typeof entry.summary !== 'string' || !entry.summary.trim()) fail('missing copy');
    if (!Array.isArray(entry.tags) || !entry.tags.length || new Set(entry.tags).size !== entry.tags.length || entry.tags.some(tag => !CHANGELOG_TAGS.includes(tag))) fail('invalid tags');
    if (!Array.isArray(entry.links) || !entry.links.length || entry.links.some(link => typeof link.label !== 'string' || !link.label.trim() || typeof link.href !== 'string' || !(COMMIT_URL.test(link.href) || /^\/(?:[a-z0-9-]+\/)*(?:#[a-z0-9-]+)?$/.test(link.href)))) fail('invalid links');
    if (!entry.links.some(link => COMMIT_URL.test(link.href)) || !entry.links.some(link => link.href.startsWith('/'))) fail('needs a site link and full public commit URL');
    const copy = [entry.title, entry.summary, ...entry.links.map(link => link.label)].join(' ');
    if (/\b(?:demo|test|tested|mock|simulated|placeholder|earn|yield|APY|returns|passive income|decentralized|trustless|anonymous)\b|local[ -]build|zero[ -]knowledge|payout|slashing|email alert|sdk release|npm|pypi/i.test(copy)) fail('unavailable feature or banned wording');
  }
  return entries;
}

export function sortChangelog(entries) {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export function filterChangelog(entries, { tag = '', query = '' } = {}) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sortChangelog(entries).filter(entry => {
    const text = [entry.title, entry.summary, entry.date, ...entry.tags].join(' ').toLowerCase();
    return (!tag || entry.tags.includes(tag)) && words.every(word => text.includes(word));
  });
}

export function groupChangelog(entries) {
  const groups = new Map();
  for (const entry of sortChangelog(entries)) {
    const month = entry.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, { month, label: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(entry.date)), entries: [] });
    groups.get(month).entries.push(entry);
  }
  return [...groups.values()];
}

export const entryUrl = entry => CHANGELOG_URL + '#' + entry.id;
