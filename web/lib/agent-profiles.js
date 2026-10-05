export const PROFILE_CATEGORIES = { spending_caps: 'Has spending caps', ask_first: 'Asks before spending', kill_switch: 'Stop switch state' };
export const PROFILE_SUMMARY = { has_spending_caps: 'Has spending caps', asks_before_spending: 'Asks before spending', kill_switch_armed: 'Stop switch armed', killed: 'Currently stopped' };
export function profilePayload(form) {
  const endpoint = (form.endpoint || '').trim();
  return { name: form.name.trim(), description: form.description.trim(), ...(form.homepage.trim() ? { homepage: form.homepage.trim() } : {}),
    ...(endpoint ? { endpoint } : {}),
    capabilities: [...new Set(form.tags.split(',').map(t => t.trim()).filter(Boolean))], show: form.show,
    certificate_claims: [...new Set(form.claims.split(',').map(t => t.trim()).filter(Boolean))] };
}
export const directoryPath = (tag = '', cursor = '') => '/api/v1/agents/profiles?' + new URLSearchParams({ ...(tag.trim() ? { tag: tag.trim() } : {}), ...(cursor ? { cursor } : {}) });
export function profileLink(card) { return '/agents/profile/?id=' + encodeURIComponent(card.anyroute.id); }
export function safeHomepage(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}

/** Liveness as one plain line: null when the card carries no liveness (the feature is off). */
export function livenessLine(liveness) {
  if (!liveness) return null;
  if (!liveness.endpoint_declared) return { state: 'none', text: 'Live check: no endpoint declared' };
  if (liveness.live === null || liveness.live === undefined) return { state: 'pending', text: 'Live check: not probed yet' };
  const day = String(liveness.probed_at || '').slice(0, 10);
  return liveness.live ? { state: 'live', text: `Live: answered on ${day}` } : { state: 'down', text: `Not live: no good answer on ${day}` };
}

/** Paid reputation as one plain line: null when the card carries none (the feature is off). */
export function reputationLine(reputation) {
  if (!reputation) return null;
  if (!reputation.opted_in) return { text: 'Paid reputation: the owner has not opted in' };
  if (!reputation.feedback_count || reputation.score === null) return { text: 'Paid reputation: no paid feedback yet' };
  const n = reputation.feedback_count;
  return { text: `Paid reputation: ${reputation.score} of 100 from ${n} paid ${n === 1 ? 'review' : 'reviews'}` };
}

export function bpsPercent(bps) { return `${(Number(bps) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`; }
