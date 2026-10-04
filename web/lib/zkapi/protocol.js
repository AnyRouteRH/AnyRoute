// ZK9: transport and policy for the pinned Rust wallet; no cryptography port.
import { checkNativeQuote } from './response-errors.js';
export const REVISION = '045b444ea1b52538d1b40273c7cb6ed09468a052';
export const CIRCUIT = 'zkapi-v2-note-bound-v1';
export const CHAIN = 11155111;
export const FEED = '0x694aa1769357215de4fac081bf1f309adc325306';
export const MAX_NOTE_USD = 5;
export const MAX_LEASE_USD = 1;
export const ENABLED = process.env.NEXT_PUBLIC_ZKAPI_ENABLED === 'true';
export const MANIFEST_URL = process.env.NEXT_PUBLIC_ZKAPI_MANIFEST_URL || '';
export const MANIFEST_SHA256 = process.env.NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256 || '';
export const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export const hexAddress = value => /^0x[\da-f]{40}$/i.test(value);
export const field = value => /^0x[\da-f]{1,64}$/i.test(value);
export function secureUrl(value) {
  const u = new URL(value);
  requireValue(u.protocol === 'https:' && !u.username && !u.password && !u.hash, 'An HTTPS URL without credentials is required.');
  return u.href.replace(/\/$/, '');
}
export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function checkedFetch(url, { fetcher = fetch, ...options } = {}) {
  const response = await fetcher(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000), ...options });
  await checkNativeQuote(response);
  if (!response.ok) throw new Error(`Request failed (${response.status}). Recovery state was preserved; retry the saved request.`);
  return response;
}
export async function loadManifest(url, hash, fetcher = fetch) {
  requireValue(/^[\da-f]{64}$/.test(hash), 'The operator manifest must have a build-time SHA-256 pin.');
  const bytes = await (await checkedFetch(secureUrl(url), { fetcher })).arrayBuffer();
  requireValue(await digest(bytes) === hash, 'Operator manifest hash mismatch.');
  return validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
}
export function normalizeHostedManifest(raw) {
  // ZK8's /config.json embeds its own setup provenance and flattened vault pins.
  if (!raw.source_commit || !raw.setup_provenance) return raw;
  requireValue(raw.source_commit === REVISION && raw.setup_provenance.circuit_revision === REVISION && raw.setup_provenance.circuit_id === CIRCUIT && raw.setup_ceremony === 'single-party' && raw.production_audited === false && raw.wei_per_billing_unit === '1000000000' && raw.native_price_feed_address?.toLowerCase() === FEED && raw.native_price_feed_decimals === 8 && raw.native_price_max_age_seconds === 4500, 'Unsupported hosted operator setup or billing pins.');
  const coordinate = value => {
    requireValue(typeof value === 'string' && /^(?:[0-9]+|0x[\da-f]+)$/i.test(value), 'Invalid hosted signing coordinate.');
    return '0x' + BigInt(value).toString(16).padStart(64, '0');
  };
  const operator = secureUrl(raw.operator_url);
  const artifact = name => ({ url: operator + '/setup/' + name + '.pk', sha256: raw.setup_provenance.artifacts?.[name + '.pk']?.sha256 });
  return { ...raw, protocol_version: raw.protocol_version ?? 2, source_revision: raw.source_commit, operator_url: operator,
    state_signing_key: { x: coordinate(raw.state_signing_key_x), y: coordinate(raw.state_signing_key_y) },
    clearance_signing_key: { x: coordinate(raw.clearance_signing_key_x), y: coordinate(raw.clearance_signing_key_y) },
    proving_keys: { request: artifact('request'), withdrawal: artifact('withdrawal') } };
}
export function validateManifest(m) {
  m = normalizeHostedManifest(m);
  requireValue(m.protocol_version === 2 && m.chain_id === CHAIN && m.source_revision === REVISION && m.circuit_id === CIRCUIT, 'Unsupported operator or circuit revision.');
  requireValue(m.billing_asset === 'native_eth' && m.billing_unit === 'gwei' && hexAddress(m.contract_address), 'Only a Sepolia native ETH vault is supported.');
  requireValue(Number.isSafeInteger(m.request_charge_cap) && m.request_charge_cap > 0, 'Invalid proof solvency minimum.');
  requireValue(typeof m.admission_enabled === 'boolean', 'Missing operator admission state.');
  for (const key of ['state_signing_key', 'clearance_signing_key']) {
    requireValue(field(m[key]?.x) && field(m[key]?.y) && (BigInt(m[key].x) !== 0n || BigInt(m[key].y) !== 0n), 'Invalid signing key pin.');
  }
  for (const key of ['operator_url', 'indexer_url']) m[key] = secureUrl(m[key]);
  for (const key of ['request', 'withdrawal']) {
    const artifact = m.proving_keys?.[key];
    requireValue(/^[\da-f]{64}$/.test(artifact?.sha256), 'Missing proving-key hash.');
    artifact.url = secureUrl(artifact.url);
    requireValue(new URL(artifact.url).origin === new URL(m.operator_url).origin, 'Proving keys must come from the configured operator.');
  }
  return m;
}
export function walletConfig(m) {
  return { protocol_version: 2, chain_id: CHAIN, contract_address: m.contract_address, request_charge_cap: m.request_charge_cap, policy_charge_cap: m.request_charge_cap, policy_enabled: false, state_signing_key: m.state_signing_key, clearance_signing_key: m.clearance_signing_key };
}
export function validateQuote(q, now = Math.floor(Date.now() / 1000)) {
  requireValue(q?.chain_id === CHAIN && q.asset === 'native_eth' && q.units_per_eth === 1e9 && q.feed_address?.toLowerCase() === FEED && q.decimals === 8, 'The quote does not match the Sepolia ETH/USD feed.');
  requireValue(/^[1-9]\d*$/.test(q.answer) && /^[1-9]\d*$/.test(q.round_id) && BigInt(q.answer) <= 10n ** 18n && BigInt(q.round_id) < 2n ** 80n, 'Invalid ETH price quote.');
  requireValue(Number.isSafeInteger(q.updated_at) && q.updated_at > 0 && q.updated_at <= now && q.expires_at === q.updated_at + 4500 && q.expires_at > now, 'The ETH price quote has expired.');
  return q;
}
export function parseEth(value) {
  requireValue(/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value), 'Enter a positive ETH amount with at most nine decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  requireValue(amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER), 'ETH amount is out of range.');
  return Number(amount);
}
export const ethFromUnits = units => `${BigInt(units) / 1_000_000_000n}.${(BigInt(units) % 1_000_000_000n).toString().padStart(9, '0')}`;
export const usdFromUnits = (units, q) => Number(BigInt(units) * BigInt(q.answer)) / 1e17;
export function checkCap(units, q, dollars) {
  requireValue(Number.isSafeInteger(units) && units > 0 && BigInt(units) * BigInt(q.answer) <= BigInt(dollars) * 10n ** 17n, `The amount exceeds the $${dollars} pilot limit.`);
}
export async function jsonRequest(base, path, body, fetcher = fetch) {
  return (await checkedFetch(base + path, { fetcher, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })).json();
}
