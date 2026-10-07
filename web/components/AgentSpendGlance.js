'use client';
// C132: one read for the whole agent list; never retain another connected key's view.
import { createElement as h, useEffect, useState } from 'react';
import { SPEND_GLANCE_PATH, spendPage, spendText, spendBars } from '../lib/spend-glance.js';

export function withSpendGlance(Caps, glance) {
  return function AgentSpend({ agent }) {
    return h('div', null, h(SpendGlanceLine, { row: glance.rows[agent.key_hash], status: glance.status }), h(Caps, { agent }));
  };
}

export function useSpendGlance(request, accountKey, revision) {
  const [state, setState] = useState({ identity: '', rows: {}, status: 'loading' });
  useEffect(() => {
    if (!accountKey) return;
    const ac = new AbortController();
    setState({ identity: accountKey, rows: {}, status: 'loading' });
    request(SPEND_GLANCE_PATH, { signal: ac.signal }).then(response => {
      const rows = spendPage(response);
      if (!ac.signal.aborted) setState({ identity: accountKey, rows, status: 'ready' });
    }).catch(() => { if (!ac.signal.aborted) setState({ identity: accountKey, rows: {}, status: 'error' }); });
    return () => ac.abort();
  }, [request, accountKey, revision]);
  return state.identity === accountKey ? state : { rows: {}, status: 'loading' };
}

export function SpendGlanceLine({ row, status = 'ready', now }) {
  if (!row) return h('span', { className: 'help-text', style: { display: 'block', marginTop: 12 } }, status === 'loading' ? 'Reading weekly spend…' : 'Weekly spend could not be read.');
  const bars = spendBars(row.daily);
  return h('span', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 12, color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' } },
    h('svg', { width: 66, height: 26, viewBox: '0 0 66 26', role: 'img', 'aria-label': 'Daily charged spend, oldest first. ' + bars.map(bar => bar.label).join('; '), style: { flexShrink: 0, color: 'var(--signal-deep)' } },
      ...bars.map(bar => h('g', { key: bar.date }, h('title', null, bar.label), h('rect', { x: bar.x, y: 24, width: 6, height: 1, fill: 'var(--line-strong)' }), h('rect', { x: bar.x, y: bar.y, width: bar.width, height: bar.height, fill: 'currentColor' })))),
    h('span', { style: { flex: '1 1 180px', minWidth: 0 } }, spendText(row, now)));
}
