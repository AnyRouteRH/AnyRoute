'use client';
import { createElement as h } from 'react';
// C134: use the account views' existing form styling and keyboard-native controls.
export default function ProjectFilter({ value = '', onChange }) {
  return h('label', null, 'Project', h('input', { value, maxLength: 48, pattern: '[a-zA-Z0-9._-]{1,48}', 'aria-label': 'Project', onChange: event => onChange(event.target.value.toLowerCase()) }), h('span', { className: 'help-text' }, 'Leave empty for all projects.'));
}
