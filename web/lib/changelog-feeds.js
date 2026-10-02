import entries from './changelog-data.js';
import { CHANGELOG_URL, entryUrl, sortChangelog, validateChangelog } from './changelog.js';

export const changelog = sortChangelog(validateChangelog(entries));
export const escapeXml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const isoDay = entry => entry.date + 'T00:00:00Z';

export function rssFeed(entries = changelog) {
  const sorted = sortChangelog(validateChangelog(entries));
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>AnyRoute changelog</title><link>${CHANGELOG_URL}</link><description>See what has shipped on AnyRoute.</description><language>en</language>
<atom:link href="${CHANGELOG_URL}rss.xml" rel="self" type="application/rss+xml"/>
<lastBuildDate>${new Date(isoDay(sorted[0])).toUTCString()}</lastBuildDate>
${sorted.map(entry => `<item><title>${escapeXml(entry.title)}</title><link>${entryUrl(entry)}</link><guid isPermaLink="true">${entryUrl(entry)}</guid><pubDate>${new Date(isoDay(entry)).toUTCString()}</pubDate><description>${escapeXml(entry.summary)}</description>${entry.tags.map(tag => `<category>${escapeXml(tag)}</category>`).join('')}</item>`).join('\n')}
</channel></rss>\n`;
}

export function atomFeed(entries = changelog) {
  const sorted = sortChangelog(validateChangelog(entries));
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${CHANGELOG_URL}</id><title>AnyRoute changelog</title><updated>${isoDay(sorted[0])}</updated><author><name>AnyRoute</name></author>
<link href="${CHANGELOG_URL}"/><link href="${CHANGELOG_URL}atom.xml" rel="self" type="application/atom+xml"/>
${sorted.map(entry => `<entry><id>${entryUrl(entry)}</id><title>${escapeXml(entry.title)}</title><updated>${isoDay(entry)}</updated><published>${isoDay(entry)}</published><link href="${entryUrl(entry)}"/>${entry.links.map(link => `<link rel="related" href="${escapeXml(link.href.startsWith('/') ? 'https://anyroute.tech' + link.href : link.href)}" title="${escapeXml(link.label)}"/>`).join('')}<summary type="text">${escapeXml(entry.summary)}</summary>${entry.tags.map(tag => `<category term="${escapeXml(tag)}"/>`).join('')}</entry>`).join('\n')}
</feed>\n`;
}

export function jsonFeed(entries = changelog) {
  return JSON.stringify({ title: 'AnyRoute changelog', url: CHANGELOG_URL, entries: sortChangelog(validateChangelog(entries)).map(entry => ({ ...entry, url: entryUrl(entry) })) }, null, 2) + '\n';
}
