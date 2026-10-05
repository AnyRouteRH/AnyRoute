import { hasModelCapability } from './model-capabilities.js';
import { sealedLabel } from './agent-sealed.js';

// Evidence is a router record, not a browser verification. Signatures remain a separate mark.
export const PROOF_STATES = Object.freeze({
  hardware: { label: 'Proven hardware', icon: 'shield', tone: 'proof', explanation: 'The hardware check passed; this does not hide ordinary prompts from the router or prove answer quality.' },
  encrypted: { label: 'Encrypted end to end', icon: 'lock', tone: 'proof', explanation: 'The device-encryption path sends ciphertext through the router to the attested gateway; routing and billing details remain visible.' },
  unlinkable: { label: 'Unlinkable route', icon: 'route', tone: 'proof', explanation: 'Tor onion access and blind tokens separate your address and payment from the request; the router still reads ordinary prompts in memory.' },
  standard: { label: 'Standard provider', icon: 'provider', tone: 'neutral', explanation: 'No hardware proof is established by this record; ordinary requests are readable by the router and provider.' },
  cached: { label: 'Stored answer', icon: 'provider', tone: 'neutral', explanation: 'This answer came from the response cache; no provider ran for this call and the router read the request in memory.' },
  signed: { label: 'Signed receipt', icon: 'signature', tone: 'neutral', explanation: 'A signature is recorded for this receipt; use the checker to verify it, its signing key and its limits.' },
});
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : '';
const signature = value => typeof value === 'string' && value.trim().length > 0;
const current = (record, now) => record && record.stale !== true && record.failed !== true && record.last_attempt_ok !== false && !['unverified', 'failed', 'stale', 'simulated', 'revoked'].includes(record.status) && (!record.expires_at || (Number.isFinite(Date.parse(record.expires_at)) && Date.parse(record.expires_at) > now));

export function proofHref(state, { providerId, receiptId } = {}) {
  const params = new URLSearchParams();
  if (id(providerId)) params.set('p', providerId);
  if (id(receiptId)) params.set('r', receiptId);
  return `/verify/${params.size ? '?' + params : ''}#proof-${state}`;
}

/** Only consume fields already available on the surface. A lane or a private boolean alone is never proof. */
export function proofBadges(evidence = {}, now = Date.now()) {
  const { source } = evidence;
  const data = evidence.data || {};
  let hardware = false, encrypted = false, unlinkable = false, cached = false, signed = false;
  let providerId = '', receiptId = '', context = '';
  if (source === 'model') {
    hardware = current(data, now) && current(data.attestation || {}, now) && data.attested_available !== false && hasModelCapability(data, 'attested');
    context = 'Available endpoint: routing may choose another provider. Ordinary Chat messages are readable by the router.';
  } else if (source === 'host') {
    hardware = data.attested === true && data.attestation?.status === 'attested' && current(data.attestation, now);
    providerId = data.id;
    context = 'Router record when loaded; refresh to check again. Build admission is a separate check.';
  } else if (source === 'admission') {
    hardware = data.attested === true && current(data, now);
    providerId = evidence.providerId;
    context = 'Router record when loaded; admission and routing health are separate checks.';
  } else if (source === 'network') {
    const age = now - Date.parse(data.as_of || '');
    hardware = Number.isSafeInteger(data.attested_hosts) && data.attested_hosts > 0 && age >= 0 && age < 30_000 && current(data, now);
    context = 'Count of hosts with fresh successful hardware and admission checks in this snapshot; inspect each host record before relying on it.';
  } else if (source === 'sealed') {
    hardware = current(data, now) && !!sealedLabel(data, now);
    context = hardware ? `Sealed hosting · image ${data.agent_image_digest}. Measured code is not audited code.` : 'Sealed hosting has no current hardware proof in this record.';
  } else if (source === 'profile') {
    // Profiles currently publish unavailable status, not a quote or expiry. Never promote owner claims.
    context = 'This profile does not publish current hardware evidence. Owner-supplied capabilities are separate.';
  } else if (source === 'generation') {
    signed = data.live === true && signature(data.signature);
    receiptId = data.id;
    context = 'This list does not include hardware evidence; inspect the receipt for the path used.';
  } else if (source === 'ledger') {
    signed = !!id(data.receipt_id);
    receiptId = data.receipt_id;
    context = 'This ledger records a receipt id; its signature has not been checked in this browser.';
  } else if (source === 'receipt') {
    const p = data.payload || {};
    receiptId = data.id || p.id;
    providerId = p.provider;
    signed = signature(data.sig);
    cached = p.mode === 'cache' || p.provider === 'cache';
    const upstream = p.upstream_attestation;
    hardware = !cached && p.disclosure === 'attested' && p.attestation_simulated !== true && current(p, now) && (!upstream || (upstream.attested === true && current(upstream, now)));
    encrypted = hardware && p.end_to_end_encrypted === true && p.provider === 'phala-confidential-ai' && p.e2ee?.version === 2 && p.e2ee?.suite === 'x25519-aes-256-gcm-hkdf-sha256' && p.e2ee?.gateway_attested === true;
    unlinkable = p.lane === 'unlinkable' && p.mode === 'blind' && !p.payer && !p.payment_tx && (signature(p.nullifier) || (Array.isArray(p.nullifiers) && p.nullifiers.length > 0));
    context = hardware ? 'The receipt records the hardware check for this call; it does not establish a current check for a later call.' : '';
  } else if (source === 'attestation') {
    hardware = data.status === 'attested' && current(data, now);
    providerId = data.provider;
    context = 'Router record when loaded; refresh to check again.';
  }
  const state = cached ? 'cached' : encrypted ? 'encrypted' : unlinkable ? 'unlinkable' : hardware ? 'hardware' : 'standard';
  const mark = key => ({ key, ...PROOF_STATES[key], hardware: key !== 'signed' && hardware, context: key === 'signed' ? '' : context, href: proofHref(key, { providerId, receiptId }) });
  return [...(evidence.signedOnly ? [] : [mark(state)]), ...(signed ? [mark('signed')] : [])];
}
