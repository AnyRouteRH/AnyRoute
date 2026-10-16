import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WeeklySummarySections from '../components/account/WeeklySummarySections.js';
const render = item => renderToStaticMarkup(h(WeeklySummarySections, { item }));
test('Monday summary sections link to the existing pages with native keyboard-accessible links', () => {
  const output = render({ kind: 'weekly_summary', sections: [
    { text: '97% of your calls succeeded', href: '/dashboard/#insights' },
    { text: 'Savings estimate: try another model', href: '/dashboard/#insights' },
    { text: 'Models you watch: model is back', href: '/models/' },
    { text: 'Agent caps: sample-agent', href: '/agents/' },
    { text: '2 approvals expired without a decision', href: '/agents/' },
  ] });
  assert.match(output, /aria-label="Weekly summary details"/);
  assert.equal((output.match(/<a /g) || []).length, 5);
  for (const href of ['/dashboard/#insights', '/models/', '/agents/']) assert.ok(output.includes(`href="${href}"`));
  assert.ok(!output.includes('tabindex="-1"'));
});
test('empty sections and other Inbox items render nothing; owner-selected names are escaped', () => {
  for (const item of [{ kind: 'weekly_summary' }, { kind: 'weekly_summary', sections: [] }, { kind: 'approval', sections: [{ text: 'hidden', href: '/agents/' }] }]) assert.equal(render(item), '');
  assert.ok(render({ kind: 'weekly_summary', sections: [{ text: '<script>sample-agent</script>', href: '/agents/' }] }).includes('&lt;script&gt;'));
});
