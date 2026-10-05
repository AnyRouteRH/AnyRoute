import { createElement as h } from 'react';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS } from '../../lib/site-map.js';
import { groupOf, groupSections } from './account-state.js';
// A plain click on a dashboard section stays on the page; modified clicks and other pages follow the link.
const follow = (section, onNavigate) => event => {
  if (!onNavigate || !section.hash || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); onNavigate(section.title);
};
// U104: the five account tabs. Real links, so they also work from /agents/ and /dashboard/webhooks/; each opens its first section.
export function AccountTabs({ current, onNavigate, className }) {
  const here = groupOf(current);
  return h('nav', { className: 'dashboard-nav' + (className ? ' ' + className : ''), 'aria-label': 'Account' }, ACCOUNT_GROUPS.map(group => {
    const first = groupSections(group)[0];
    return h('a', { key: group.id, href: first.href, 'aria-current': group === here ? 'true' : undefined, onClick: follow(first, onNavigate) }, group.title);
  }));
}
// The sections of the current tab.
export function AccountNavigation({ current, onNavigate }) {
  const group = groupOf(current);
  return h('nav', { 'aria-label': `${group.title} sections` }, h('div', null,
    h('span', { className: 'eyebrow' }, group.title),
    ...groupSections(group).map(section => h('a', { key: section.taskId, href: section.href, 'aria-current': current === section.title ? 'page' : undefined, onClick: follow(section, onNavigate) }, section.title))));
}
// What signed-out visitors see on Home: the six things it shows once a key is connected. No numbers.
export const HOME_PREVIEW = [
  ['Balance', 'What you can spend, and how to add funds.'],
  ['Spending', 'Today and this week, in USDG.'],
  ['Keys', 'Your API keys and what each one can do.'],
  ['Agents', 'Each agent and its budget, and any you have stopped.'],
  ['Waiting for you', 'Agent payments that need your approval.'],
  ['Recent calls', 'Your last five calls, each with its signed receipt.'],
];
export function AccountPreview({ current, children }) {
  const section = ACCOUNT_SECTIONS.find(item => item.title === current) || ACCOUNT_SECTIONS[0];
  return h('section', { className: 'control-panel', 'aria-labelledby': 'account-preview-title' },
    h('span', { className: 'eyebrow' }, 'Your account'), h('h2', { id: 'account-preview-title', tabIndex: -1 }, section.title),
    h('p', null, section.description), h('p', { className: 'help-text' }, section.start),
    section.title === 'Home' ? h('div', { className: 'account-preview-grid', 'aria-label': 'What your Home shows' },
      HOME_PREVIEW.map(([title, text]) => h('div', { key: title }, h('strong', null, title), h('span', null, text)))) : null,
    children);
}
