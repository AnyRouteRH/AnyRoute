'use client';
// C127: use the account's existing field, badge and button styles.
import { createElement as h, Fragment } from 'react';
import { EXPIRY_OPTIONS, EXPIRY_WARNING, earliestExpiryDate, expiryText, keyHasExpired } from '../../lib/key-expiry.js';

export function KeyExpiryFields({ choice, date, onChoice, onDate, current, edited = true, now = Date.now() }) {
  return h('div', { className: 'field' },
    h('label', { htmlFor: 'key-expiry' }, 'Expires'),
    h('select', { id: 'key-expiry', value: choice, onChange: event => onChoice(event.target.value), 'aria-describedby': current ? 'key-expiry-warning' : undefined },
      EXPIRY_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label))),
    choice === 'date' && h(Fragment, null,
      h('label', { htmlFor: 'key-expiry-date' }, 'Expiry date'),
      h('input', { id: 'key-expiry-date', type: 'date', value: date, min: edited ? earliestExpiryDate(now) : undefined, required: true, onChange: event => onDate(event.target.value) }),
      h('p', { className: 'help-text' }, 'Expires at the start of this date in your timezone.')),
    current && h('p', { id: 'key-expiry-warning', className: 'help-text' }, EXPIRY_WARNING));
}

export function KeyExpiryStatus({ value, now, children }) {
  const text = expiryText(value, now);
  if (!text) return children;
  return h('div', { className: 'key-expiry-status' },
    keyHasExpired(value, now) ? h('span', { className: 'badge' }, 'Expired · switched off') : children,
    !keyHasExpired(value, now) && h('p', { className: 'help-text' }, h('time', { dateTime: value, title: new Date(value).toLocaleString() }, text)));
}

export function KeyExpiryRestore({ value, team, now, onEdit, children }) {
  if (!keyHasExpired(value, now)) return children;
  return team ? null : h('button', { className: 'text-button', onClick: onEdit }, 'Change expiry');
}
