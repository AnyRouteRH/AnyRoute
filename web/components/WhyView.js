// K190: keep the public view generic even if a caller passes old owner details.
import { createElement as h } from 'react';
export default function WhyView({ explanation, details, signedIn = false }) {
  const data = signedIn ? details : null;
  const list = (items, name) => h('ul', { 'aria-label': name }, items.map((text, i) => h('li', { key: i }, text)));
  return h('section', { 'aria-label': 'Refusal explanation' },
    h('h2', null, explanation.title), h('p', null, explanation.text),
    h('p', null, h('a', { className: 'inline-link', href: explanation.href }, explanation.action)),
    data ? h('div', null, h('h3', null, 'Your recorded request'),
      h('p', null, 'Recorded ', h('time', { dateTime: data.recorded_at }, new Date(data.recorded_at).toLocaleString('en-US', { timeZone: 'UTC' })), ' UTC'),
      h('ul', { 'aria-label': 'Rules that refused this request' }, data.reasons.map((reason, i) => h('li', { key: i }, h('p', null, reason.text), h('a', { className: 'inline-link', href: reason.href }, reason.action)))),
      data.facts.length ? list(data.facts, 'Recorded numbers') : null,
      data.rules.length ? h('div', null, h('h3', null, 'Rules saved at the time'), list(data.rules, 'Saved rules')) : null,
      h('p', { className: 'help-text' }, data.note))
      : h('p', { className: 'help-text' }, signedIn ? 'No matching retained agent decision is available to this account. Some refusals happen before an agent event is recorded. The API refusal may contain amounts that this page cannot recover.' : 'Connect your account management key to read any retained details for your own request. Everyone else sees this general explanation.'),
    h('p', { className: 'help-text' }, 'Rules apply to requests through Anyroute. Ordinary request text is read by the router in memory. This page adds no request storage.')
  );
}
