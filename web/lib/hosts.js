import { describeWindow } from './proof-time.js';
import { verifyHref } from './verify.js';

export const HOSTS_PATH = '/api/v1/hosts';
export const hostPath = id => `${HOSTS_PATH}/${encodeURIComponent(id)}`;
export const hostHref = id => `/hosts/?id=${encodeURIComponent(id)}`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function hostId(search, hash) {
  let fragment;
  try { fragment = decodeURIComponent(String(hash || '').replace(/^#(?:id=)?/, '')); } catch { return ''; }
  const id = new URLSearchParams(search || '').get('id') || fragment || '';
  return ID.test(id) ? id : '';
}
export function rekorHref(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
export function describeHost(host, now = Date.now()) {
  const h = host || {};
  const hardware = h.attested === true && h.attestation?.status === 'attested';
  const root = h.anchoring?.latest;
  const m = h.measurement;
  const proof = h.proof_time;
  return {
    ...h,
    href: hostHref(h.id || ''), verifyHref: verifyHref(h.id || ''),
    hardware: { label: hardware ? 'Hardware verified' : 'No current hardware verification', tone: hardware ? 'ok' : 'warn' },
    build: { label: 'Approval not established', tone: 'warn', text: 'Measurements record what the quote bound. This record does not establish build admission approval or prove that source matches the running software.' },
    anchor: { label: root?.anchored === true && root?.status === 'confirmed' && root?.tx_hash ? 'Work anchored on chain' : root?.status === 'local' ? 'Root kept off chain' : root ? 'Awaiting on-chain confirmation' : 'No work roots recorded', tone: root?.anchored === true && root?.status === 'confirmed' && root?.tx_hash ? 'ok' : 'warn' },
    uptimeText: Number.isFinite(h.uptime?.success_pct_30d) && h.uptime?.observations_30d > 0 ? `${h.uptime.success_pct_30d}% across ${h.uptime.observations_30d} observations` : 'No observations recorded',
    windows: proof?.host ? ['24h', '7d'].map(key => describeWindow(key, proof.host.fresh?.[key], proof.host.measurement_changes_7d, now)) : [],
    measurements: [m && { ...m, current: true }, ...(Array.isArray(h.measurement_history) ? h.measurement_history.map(row => ({ ...row, current: false })) : [])].filter(Boolean).map(row => ({ ...row, rekorHref: rekorHref(row.transparency_log?.entry_url) })),
    events: Array.isArray(h.attestation_history?.data) ? h.attestation_history.data : [],
    earningsText: h.earnings?.band || 'No invoices recorded',
  };
}

// Same resource-bound hash as src/api/hosts.ts. No wallet details are kept by this page.
export async function operatorHeader(wallet, id, subtle = globalThis.crypto.subtle, now = Date.now()) {
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(accounts?.[0] || '')) throw new Error('The wallet did not return an address.');
  const ts = Math.floor(now / 1000);
  const hash = await subtle.digest('SHA-256', new TextEncoder().encode(`GET ${hostPath(id)}`));
  const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  const message = `anyroute:${ts}:${hex}`;
  const encoded = '0x' + [...new TextEncoder().encode(message)].map(b => b.toString(16).padStart(2, '0')).join('');
  const signature = await wallet.request({ method: 'personal_sign', params: [encoded, accounts[0]] });
  return `${accounts[0]}:${ts}:${signature}`;
}
