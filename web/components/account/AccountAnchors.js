import { createElement as h, Fragment } from 'react';
import { ACCOUNT_SECTIONS } from '../../lib/site-map.js';
export default function AccountAnchors() {
  return h(Fragment, null, h('span', { id: 'overview', className: 'dashboard-anchor', 'aria-hidden': true }),
    ACCOUNT_SECTIONS.filter(section => section.hash).map(section => h('span', { key: section.hash, id: section.hash, className: 'dashboard-anchor', 'aria-hidden': true })));
}
