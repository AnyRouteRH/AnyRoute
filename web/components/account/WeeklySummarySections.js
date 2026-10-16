// J184: links reuse the Inbox item's existing account visibility and notification preference.
import { createElement as h } from 'react';
export default function WeeklySummarySections({ item }) {
  if (item.kind !== 'weekly_summary' || !item.sections?.length) return null;
  return h('ul', { 'aria-label': 'Weekly summary details' }, item.sections.map(section =>
    h('li', { key: section.text }, h('a', { className: 'inline-link', href: section.href }, section.text))));
}
