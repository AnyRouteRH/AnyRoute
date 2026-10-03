// The paid tool catalog page (/tools/): reads GET /api/v1/tools and describes each listing in words.
export const TOOLS_PATH = '/api/v1/tools';

const STATE = {
  passing: 'Canary passing',
  failing: 'Canary failing',
  delisted: 'Delisted',
  unchecked: 'Not probed yet',
};

const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : 'Price on request');

/** Rows for the page: state words, price, seller wallet and a ready call body. Never trusts a field to be present. */
export function describeTools(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && typeof t.resource === 'string').map((t) => {
    const q = t.quality || {};
    const state = STATE[q.state] ? q.state : 'unchecked';
    const failures = Number(q.consecutive_failures) || 0;
    return {
      id: String(t.id || t.resource),
      name: String(t.name || t.resource),
      summary: String(t.summary || ''),
      resource: t.resource,
      method: t.method === 'POST' ? 'POST' : 'GET',
      price: usd(t.price_usd),
      priceUsd: typeof t.price_usd === 'number' && Number.isFinite(t.price_usd) ? t.price_usd : null,
      payTo: typeof t.pay_to === 'string' ? t.pay_to : '',
      skill: t.source === 'skill' ? t.skill_id : null,
      state,
      stateLabel: state === 'failing' ? `${STATE.failing} (${failures} of 3)` : STATE[state],
      checked: q.checked_at || null,
    };
  });
}

export function filterTools(rows, query = '') {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => words.every((w) => `${r.name} ${r.summary} ${r.resource}`.toLowerCase().includes(w)));
}

/** The request body for POST /api/v1/tools/call, with a max_price a little above the listed price. */
export function callBody(row) {
  const priceUsd = row.priceUsd;
  const max = typeof priceUsd === 'number' && priceUsd > 0 ? Math.ceil(Math.round(priceUsd * 1.05 * 1e9) / 1e3) / 1e6 : 0.01;
  return JSON.stringify({ resource: row.resource, method: row.method, max_price: max }, null, 2);
}
