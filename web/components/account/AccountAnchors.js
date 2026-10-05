import { createElement as h, Fragment } from 'react';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS } from '../../lib/site-map.js';
// Every dashboard hash has an anchor: the sections' own, plus the five tab ids (U104), which open each tab's first section.
export const anchorIds = () => [...new Set(['overview', ...ACCOUNT_SECTIONS.filter(section => section.hash).map(section => section.hash), ...ACCOUNT_GROUPS.map(group => group.id)])];
export default function AccountAnchors() {
  return h(Fragment, null, anchorIds().map(id => h('span', { key: id, id, className: 'dashboard-anchor', 'aria-hidden': true })));
}
