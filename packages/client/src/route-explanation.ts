// V84: validate a versioned receipt/header extension; never infer a route from model labels.
export const ROUTE_REASONS = ['lowest_price', 'lowest_latency', 'highest_throughput', 'weighted_choice', 'provider_order', 'preferred_performance', 'byok_priority', 'only_eligible', 'only_parameter_support', 'fallback'];
export const SKIP_REASONS = ['health', 'lane', 'disclosure', 'attestation', 'parameters', 'price', 'context', 'preferences', 'availability', 'other'];
export const ERROR_CLASSES = ['http_5xx', 'timeout', 'connection', 'rate_limited', 'provider_auth', 'rejected', 'empty200', 'unreadable', 'interrupted', 'other'];
export const ROUTE_PARAMETERS = ['tools', 'tool_choice', 'response_format', 'temperature', 'seed', 'max_tokens', 'stop', 'top_p', 'top_k', 'reasoning', 'include_reasoning', 'modalities', 'audio'];
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const counts = (value: any, keys: string[]) => object(value) && Object.entries(value).every(([key, n]) => keys.includes(key) && typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
export function validRouteExplanation(route: any, provider?: unknown) {
  return !!(object(route) && Object.keys(route).every(k => ['v', 'provider', 'reason', 'eligible', 'skipped', 'lane', 'parameters', 'network_host', 'fallback'].includes(k)) &&
    ['v', 'provider', 'reason', 'eligible', 'skipped', 'lane', 'parameters', 'network_host'].every(k => Object.hasOwn(route, k)) &&
    route.v === 1 && typeof route.provider === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(route.provider) && (provider === undefined || route.provider === provider) &&
    ROUTE_REASONS.includes(route.reason) && Number.isSafeInteger(route.eligible) && route.eligible > 0 && counts(route.skipped, SKIP_REASONS) &&
    ['public', 'attested', 'unlinkable'].includes(route.lane) && typeof route.network_host === 'boolean' && Array.isArray(route.parameters) && route.parameters.length <= ROUTE_PARAMETERS.length &&
    new Set(route.parameters).size === route.parameters.length && route.parameters.every((p: string) => ROUTE_PARAMETERS.includes(p)) &&
    (route.reason === 'fallback' ? counts(route.fallback, ERROR_CLASSES) && Object.keys(route.fallback).length > 0 : !Object.hasOwn(route, 'fallback')));
}

