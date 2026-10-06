import { createElement as h } from 'react';
import { lastUsedText } from '../../lib/unused-keys.js';
// B125: the existing list supplies the timestamp; this browser's key is never a cleanup target.
export default function KeyLastUsed({ value, current, now }) {
  return h('p', { className: 'help-text' }, 'Last call: ',
    value && Number.isFinite(Date.parse(value)) ? h('time', { dateTime: value, title: new Date(value).toUTCString() }, lastUsedText(value, now)) : lastUsedText(value, now),
    current ? h('span', null, " · This browser's key") : null);
}
