export const PROFILE_CATEGORIES = { spending_caps: 'Has spending caps', ask_first: 'Asks before spending', kill_switch: 'Kill switch state' };
export const PROFILE_SUMMARY = { has_spending_caps: 'Has spending caps', asks_before_spending: 'Asks before spending', kill_switch_armed: 'Kill switch armed', killed: 'Currently killed' };
export function profilePayload(form) {
  return { name: form.name.trim(), description: form.description.trim(), ...(form.homepage.trim() ? { homepage: form.homepage.trim() } : {}),
    capabilities: [...new Set(form.tags.split(',').map(t => t.trim()).filter(Boolean))], show: form.show,
    certificate_claims: [...new Set(form.claims.split(',').map(t => t.trim()).filter(Boolean))] };
}
export const directoryPath = (tag = '', cursor = '') => '/api/v1/agents/profiles?' + new URLSearchParams({ ...(tag.trim() ? { tag: tag.trim() } : {}), ...(cursor ? { cursor } : {}) });
export function profileLink(card) { return '/agents/profile/?id=' + encodeURIComponent(card.anyroute.id); }
export function safeHomepage(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
