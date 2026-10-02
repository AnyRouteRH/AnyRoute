import { createElement as h } from 'react';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS } from '../../lib/site-map.js';
export function AccountNavigation({ current, onNavigate }) {
  return h('nav', { 'aria-label': 'Account sections' }, ACCOUNT_GROUPS.map(group => h('div', { key: group.title },
    h('span', { className: 'eyebrow' }, group.title),
    ...group.ids.map(id => {
      const section = ACCOUNT_SECTIONS.find(item => item.taskId === id);
      return h('a', { key: id, href: section.href, 'aria-current': current === section.title ? 'page' : undefined,
        onClick: event => {
          if (!onNavigate || !section.hash || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); onNavigate(section.title);
        } }, section.title);
    }))));
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
