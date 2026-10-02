import { createElement as h } from 'react';
import { inboxBadge } from '../../lib/inbox.js';
export default function InboxTrigger({ connected, count, error, open, onClick, buttonRef, className, badgeClass }) {
  if (!connected) return null;
  const label = error ? 'Open inbox. Count unavailable.' : count === undefined ? 'Open inbox. Reading count.' : `Open inbox. ${count} ${count === 1 ? 'item needs' : 'items need'} attention.`;
  return h('button', { ref: buttonRef, className, 'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick },
    h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, h('path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4' })),
    count > 0 ? h('span', { className: badgeClass, 'aria-hidden': true }, inboxBadge(count)) : null);
}
