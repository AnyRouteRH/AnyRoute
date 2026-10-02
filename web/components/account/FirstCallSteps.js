import { createElement as h } from 'react';
import { firstCallSteps } from '../../lib/first-call.js';
export default function FirstCallSteps({ snapshot }) {
  return h('ol', { className: 'first-call-steps', 'aria-label': 'Your first API call', 'aria-live': 'polite' },
    firstCallSteps(snapshot).map((step, index) => h('li', { key: step.id },
      h('span', { className: 'first-call-mark', 'data-done': step.done, 'aria-hidden': true }, step.done ? '✓' : index + 1),
      h('div', null, h('a', { className: 'inline-link', href: step.href }, step.title),
        h('span', { className: 'first-call-status' }, step.done ? 'Done' : step.unknown ? 'Not checked' : 'Not done'),
        h('p', { className: 'help-text' }, step.text)))));
}
