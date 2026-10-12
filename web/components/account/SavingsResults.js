import { createElement as h } from 'react';
import { savingsMoney } from '../../lib/savings.js';
import { modelPageHref } from '../../lib/model-page.js';
export default function SavingsResults({ report }) {
  return h('div', null,
    h('p', { className: 'help-text' }, (report.scope === 'account' ? 'Across your visible account keys.' : 'For this key only.') + ' Charged calls from the last ' + report.days + ' days.'),
    report.models.length ? h('ul', { className: 'savings-list' }, report.models.map(row => h('li', { key: row.model },
      h('h3', null, row.name),
      h('p', null, 'Same tokens on ' + row.alternative.name + ': about ' + savingsMoney(row.alternative.estimated_cost_usd) + ' instead of ' + savingsMoney(row.charged_usd) + '.'),
      h('p', { className: 'help-text' }, 'Estimate at current catalogue prices; no claim of equal quality.'),
      h('div', { className: 'button-row' },
        h('a', { className: 'inline-link', href: modelPageHref(row.alternative.model) }, 'View ' + row.alternative.name),
        h('a', { className: 'inline-link', href: '/harness/?model=' + encodeURIComponent(row.alternative.model) }, 'Try in Chat')))))
      : h('p', null, 'No cheaper match found with enough information about your calls and the models’ abilities.'),
    h('p', { className: 'help-text' }, 'Estimates use the same input and output token counts plus a charge per call when listed. Refunds, cache discounts, royalties, account fees and extra media, reasoning or search charges are excluded. Routing and future usage can change the cost.'),
    h('p', { className: 'help-text' }, 'Call records do not keep a list of abilities used. Matches preserve all abilities declared for the original model and its full context window. Missing information or costs that cannot be safely compared leave a model out.'));
}
