import { createElement as h } from 'react';
import { ADD_FUNDS_HREF, balanceLabel, bellBadge, bellLabel, formatBalance } from '../../lib/account-strip.js';
// U105: the two header controls, without styles, so they also render in node.
export function BalanceLink({ snapshot, className }) {
  return h('a', { className, href: ADD_FUNDS_HREF, 'aria-label': balanceLabel(snapshot) }, formatBalance(snapshot?.balance));
}
export function BellButton({ snapshot, open, onClick, buttonRef, className, badgeClass }) {
  const badge = bellBadge(snapshot);
  return h('button', { ref: buttonRef, type: 'button', className, 'aria-label': bellLabel(snapshot), 'aria-haspopup': 'dialog', 'aria-expanded': !!open, onClick },
    h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, h('path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4' })),
    badge ? h('span', { className: badgeClass, 'aria-hidden': true }, badge) : null);
}
