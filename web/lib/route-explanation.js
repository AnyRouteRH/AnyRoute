// V84: validate a versioned receipt/header extension; never infer a route from model labels.
export const ROUTE_REASONS = ['lowest_price', 'lowest_latency', 'highest_throughput', 'weighted_choice', 'provider_order', 'preferred_performance', 'byok_priority', 'only_eligible', 'only_parameter_support', 'fallback'];
export const SKIP_REASONS = ['health', 'lane', 'disclosure', 'attestation', 'parameters', 'price', 'context', 'preferences', 'availability', 'other'];
export const ERROR_CLASSES = ['http_5xx', 'timeout', 'connection', 'rate_limited', 'provider_auth', 'rejected', 'empty200', 'unreadable', 'interrupted', 'other'];
export const ROUTE_PARAMETERS = ['tools', 'tool_choice', 'response_format', 'temperature', 'seed', 'max_tokens', 'stop', 'top_p', 'top_k', 'reasoning', 'include_reasoning', 'modalities', 'audio'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const counts = (value, keys) => object(value) && Object.entries(value).every(([key, n]) => keys.includes(key) && Number.isSafeInteger(n) && n > 0);
export function validRouteExplanation(route, provider) {
  return !!(object(route) && Object.keys(route).every(k => ['v', 'provider', 'reason', 'eligible', 'skipped', 'lane', 'parameters', 'network_host', 'fallback'].includes(k)) &&
    ['v', 'provider', 'reason', 'eligible', 'skipped', 'lane', 'parameters', 'network_host'].every(k => Object.hasOwn(route, k)) &&
    route.v === 1 && typeof route.provider === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(route.provider) && (provider === undefined || route.provider === provider) &&
    ROUTE_REASONS.includes(route.reason) && Number.isSafeInteger(route.eligible) && route.eligible > 0 && counts(route.skipped, SKIP_REASONS) &&
    ['public', 'attested', 'unlinkable'].includes(route.lane) && typeof route.network_host === 'boolean' && Array.isArray(route.parameters) && route.parameters.length <= ROUTE_PARAMETERS.length &&
    new Set(route.parameters).size === route.parameters.length && route.parameters.every(p => ROUTE_PARAMETERS.includes(p)) &&
    (route.reason === 'fallback' ? counts(route.fallback, ERROR_CLASSES) && Object.keys(route.fallback).length > 0 : !Object.hasOwn(route, 'fallback')));
}

export function routeEvidence(receipt, header) {
  // Prefer signed fields; this UI does not verify the signature itself.
  if (receipt?.payload?.mode === 'cache' || receipt?.payload?.provider === 'cache') return null;
  const fromReceipt = receipt?.payload?.route ?? receipt?.v2?.claims?.route;
  if (fromReceipt !== undefined) return validRouteExplanation(fromReceipt, receipt?.payload?.provider ?? receipt?.v2?.claims?.node?.provider) ? fromReceipt : null;
  if (typeof header !== 'string' || header.length > 4096) return null;
  try { const route = JSON.parse(header); return validRouteExplanation(route) ? route : null; } catch { return null; }
}

const skipWords = { health: 'health', lane: 'lane rules', disclosure: 'disclosure rules', attestation: 'hardware checks', parameters: 'required parameters', price: 'price limits', context: 'context limits', preferences: 'provider preferences', availability: 'availability', other: 'other routing rules' };
const errorWords = { http_5xx: 'a provider server error', timeout: 'a timeout', connection: 'a connection error', rate_limited: 'a rate limit', provider_auth: 'a provider authentication error', rejected: 'a rejected request', empty200: 'an empty reply', unreadable: 'an unreadable reply', interrupted: 'an interrupted reply', other: 'a provider error' };
export function routeSentence(route) {
  if (!validRouteExplanation(route)) return '';
  const providers = `${route.eligible} eligible provider${route.eligible === 1 ? '' : 's'}`;
  const why = {
    lowest_price: `it was first in price order among ${providers}`,
    lowest_latency: `it was first in latency order among ${providers}`,
    highest_throughput: `it was first in output-speed order among ${providers}`,
    weighted_choice: `a weighted choice used price, health, quality and hardware checks across ${providers}`,
    provider_order: `your provider order placed it first among ${providers}`,
    preferred_performance: `the preferred speed and latency order placed it first among ${providers}`,
    byok_priority: `your own provider key gave it priority among ${providers}`,
    only_eligible: 'it was the only eligible provider',
    only_parameter_support: 'it was the only eligible provider supporting the required parameters',
    fallback: `earlier attempts failed (${Object.entries(route.fallback || {}).map(([k, n]) => `${n} × ${errorWords[k]}`).join('; ')}); ${providers} were available in the serving model’s plan`,
  }[route.reason];
  const skips = Object.entries(route.skipped).map(([k, n]) => `${n} ${n === 1 ? 'was' : 'were'} skipped for ${skipWords[k]}`).join('; ');
  return `Sent to ${route.provider} because ${why}.${route.lane !== 'public' ? ` The ${route.lane} lane was required.` : ''}${route.parameters.length ? ` Required parameter rules: ${route.parameters.map(p => p === 'tools' ? 'tools' : p.replaceAll('_', ' ')).join(', ')}.` : ''}${skips ? ` ${skips}.` : ''}${route.network_host ? ' This provider is a network host.' : ''}`;
}
