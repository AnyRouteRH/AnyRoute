'use client';
import { useState } from 'react';
import { CHANGELOG_TAGS, filterChangelog, groupChangelog } from '../../lib/changelog.js';
import s from './changelog.module.css';

export default function Changelog({ entries }) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const shown = filterChangelog(entries, { query, tag });
  return <div className={s.body}>
    <div className={s.filters} role="search" aria-label="Search shipped changes">
      <label className={s.search}>Search changes<input type="search" value={query} onChange={e => setQuery(e.target.value)} autoComplete="off"/></label>
      <label>Filter by tag<select value={tag} onChange={e => setTag(e.target.value)}><option value="">All tags</option>{CHANGELOG_TAGS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      {(query || tag) && <button className="text-button" onClick={() => { setQuery(''); setTag(''); }}>Clear filters</button>}
    </div>
    <p className={s.count} role="status">{shown.length} {shown.length === 1 ? 'change' : 'changes'}</p>
    {!shown.length && <p>No changes match. Try another search or clear the filters.</p>}
    {groupChangelog(shown).map(group => <section key={group.month} aria-labelledby={`month-${group.month}`} className={s.month}>
      <h2 id={`month-${group.month}`}>{group.label}</h2>
      <div>{group.entries.map(entry => <article key={entry.id} id={entry.id} className={s.entry}>
        <div className={s.meta}><time dateTime={entry.date}>{entry.date} UTC</time><span>{entry.tags.join(' · ')}</span></div>
        <h3><a href={`#${entry.id}`} aria-label={`${entry.title}, permalink`}>{entry.title}</a></h3>
        <p>{entry.summary}</p>
        <ul className={s.links} aria-label={`Links for ${entry.title}`}>{entry.links.map((link, index) => <li key={link.href}><a href={link.href}>{link.label}{link.label === 'View commit' && entry.links.filter(item => item.label === 'View commit').length > 1 ? ` ${index}` : ''}<span aria-hidden="true"> ↗</span></a></li>)}</ul>
      </article>)}</div>
    </section>)}
  </div>;
}
