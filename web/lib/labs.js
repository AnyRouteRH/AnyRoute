// U104: the Labs page. Features that are built but switched off, or still a pilot, each with its state read from the
// public GET /api/v1/status when the page opens. Pure mapping: status data in, rows out. A row reads one field and says
// which; a field the router does not report is "Not reported", never a guess. Rows without a status field carry the
// state their own documentation states.

export const STATUS_PATH = '/api/v1/status';
export const UNREAD = 'Couldn’t read live status';
export const READING = 'Reading live status…';

/** Each feature: `field` is the status path it reads; `documented` is the state for the ones the status does not carry. */
export const LABS = [
  { id: 'agent-guard', name: 'Agent Guard', field: 'agent_guard.enabled', absentIsOff: true, href: '/docs/#agent-guard',
    blurb: 'Your agent asks its rulebook before an action with money, such as an order or a payment, and waits for you above an amount you set.' },
  { id: 'agent-pay', name: 'Pay another agent', field: 'agent_pay.enabled', absentIsOff: true, href: '/docs/#agent-pay',
    blurb: 'Your agent pays another agent in USDG from its own wallet, after its rulebook allows it, and gets a signed receipt. Anyroute never holds the money.' },
  { id: 'x402', name: 'Pay per call with x402', field: 'per_call.x402.configured', offLabel: 'Not live', href: '/docs/#x402',
    blurb: on => `${on ? '' : 'Built, not live. '}Pay for one call in USDG with an x402 signature, with no account and no key.` },
  { id: 'paid-tools', name: 'Paid tools from your balance', field: 'tools.ready', href: '/docs/#paid-tools',
    blurb: 'An agent buys a call to a paid tool from its key’s balance, within a price per call and a daily budget.' },
  { id: 'decision-tags', name: 'Decision tags', field: 'decision_tags.enabled', href: '/docs/#trading-agents',
    blurb: 'Sign the SHA-256 of an order intent into the receipt of the model call that informed it.' },
  { id: 'data-tools', name: 'Market data tools', field: 'data_tools.enabled', href: '/docs/#trading-agents',
    blurb: 'Read-only market data charged per call: a Stock Token’s price from its Chainlink feed, its corporate actions, and the inference price index.' },
  { id: 'make-good', name: 'Make-good refunds', field: 'makegood.enabled', href: '/docs/#make-good-refunds',
    blurb: 'A call that fails you is refunded by fixed rules, decided from what the router recorded, with a signed refund receipt.' },
  { id: 'identity', name: 'Agent identity and reputation', field: 'identity.enabled', href: '/docs/#agent-identity',
    blurb: 'Register a published agent on the ERC-8004 registries on Robinhood Chain, with feedback backed by its receipts.' },
  { id: 'commerce', name: 'Commerce ledger', field: 'commerce.enabled', href: '/commerce/',
    blurb: 'Public totals of paid settlements between agents, sellers and the router, counted once their receipts are anchored.' },
  { id: 'facilitator', name: 'Payment facilitator for sellers', field: 'facilitator.enabled', href: '/facilitator/',
    blurb: 'Verify and settle USDG payments for your own API on Robinhood Chain; the router pays only the gas.' },
  { id: 'zkapi', name: 'Pay with zkAPI', documented: 'Pilot', href: '/zkapi/',
    blurb: 'A Sepolia pilot that keeps your funding wallet apart from your calls with an ETH note. Experimental and unaudited.' },
  { id: 'host-bonds', name: 'Host bonds', documented: 'Off', href: '/docs/#host-bonds',
    blurb: 'Switched off at anyroute.tech: hosts are weighted by attestation, probation, uptime, errors and latency instead.' },
];

const at = (data, field) => field.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), data);

/**
 * Rows for the page. `phase` is 'loading' before the status answers, 'error' when it could not be read, and 'ready'
 * with `data` (the status body's `data`). Each row: id, name, href, blurb, field (null for documented rows), source
 * ('status' or 'docs'), state ('on' | 'off' | 'pilot' | 'unknown' | 'loading') and the label shown for that state.
 */
export function labRows(data, phase = 'ready') {
  const ready = phase === 'ready' && !!data && typeof data === 'object';
  return LABS.map(item => {
    const base = { id: item.id, name: item.name, href: item.href, field: item.field ?? null, source: item.documented ? 'docs' : 'status' };
    const blurb = on => (typeof item.blurb === 'function' ? item.blurb(on) : item.blurb);
    if (item.documented) return { ...base, state: item.documented === 'Pilot' ? 'pilot' : 'off', label: item.documented, blurb: blurb(false) };
    // Before the status answers, or when it cannot be read, no row says on or off; the page shows READING or UNREAD once.
    if (!ready) return { ...base, state: phase === 'loading' ? 'loading' : 'unknown', label: phase === 'loading' ? 'Reading…' : 'Unknown', blurb: blurb(false) };
    let value = at(data, item.field);
    // Agent Guard's section is left out of the status while it is off (its docs say to read an absent field as off); a
    // router from before Pay another agent has no agent_pay section, and it is off there too.
    if (value === undefined && item.absentIsOff && at(data, item.field.split('.')[0]) === undefined) value = false;
    const state = value === true ? 'on' : value === false ? 'off' : 'unknown';
    return { ...base, state, label: state === 'on' ? 'On' : state === 'off' ? item.offLabel ?? 'Off' : 'Not reported', blurb: blurb(state === 'on') };
  });
}

/** Read the status once and map it; any failure (network, HTTP, JSON) gives the "couldn't read" rows. */
export async function loadLabRows(base, fetchImpl, signal) {
  try {
    const res = await fetchImpl(base + STATUS_PATH, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('status ' + res.status);
    const body = await res.json();
    if (!body?.data || typeof body.data !== 'object') throw new Error('no status data');
    return { phase: 'ready', rows: labRows(body.data) };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { phase: 'error', rows: labRows(null, 'error') };
  }
}
