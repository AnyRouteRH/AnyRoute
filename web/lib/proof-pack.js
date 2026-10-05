// U100: proof packs. One JSON file for a date range: the key's calls with their signed receipts, the statements and
// refund receipts for those dates and the router's signing keys. scripts/verify-proof-pack.mjs checks it with no network.
export const PROOF_PACK_TYPE = 'anyroute.proof-pack.v1';
export const PROOF_PACK_LIMITS_PATH = '/api/v1/proof-pack/limits';
export const PROOF_PACK_VERIFY_COMMAND = 'node verify-proof-pack.mjs anyroute-proof-pack.json';
const DAY_MS = 86400000;
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

export function proofPackPath({ from, to, cursor }) {
  const query = new URLSearchParams({ from, to });
  if (cursor) query.set('cursor', cursor);
  return '/api/v1/proof-pack?' + query;
}

/** The last 30 days, today included, as UTC dates. */
export function defaultProofPackRange(now = new Date()) {
  return { from: new Date(now.getTime() - 29 * DAY_MS).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

/** A sentence for the first problem with a range, or '' when the router will accept it. */
export function proofPackRangeError({ from, to }, maxDays = 31, now = new Date()) {
  if (!isDate(from) || !isDate(to)) return 'Choose a start and an end date.';
  if (to < from) return 'The end date must be on or after the start date.';
  if (from > now.toISOString().slice(0, 10)) return 'The range starts in the future.';
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  return days > maxDays ? `A proof pack covers at most ${maxDays} days. This range has ${days}.` : '';
}

export function proofPackFilename(pack) {
  return `anyroute-proof-pack-${pack.range.from}-to-${pack.range.to}${pack.part > 1 ? `-part-${pack.part}` : ''}.json`;
}

/** Check the response is a proof pack before it is saved, and say what it holds. */
export function proofPackSummary(value) {
  const pack = value?.data ?? value;
  if (pack?.type !== PROOF_PACK_TYPE || !Array.isArray(pack.calls) || !pack.manifest?.sig || !Array.isArray(pack.keys?.keys)) throw new Error('The proof pack could not be read.');
  return { pack, part: pack.part, calls: pack.calls.length, refunds: pack.refunds?.length ?? 0, statements: pack.statements?.length ?? 0, paths: pack.counts?.merkle_paths ?? 0, decisionTags: Array.isArray(pack.decision_tags) ? pack.decision_tags.length : 0, scope: pack.scope, next: pack.next_cursor || null };
}
