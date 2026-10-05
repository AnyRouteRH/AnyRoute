// U101: the rulebook's default route (route_default) for requests that name no lane. "standard" is the default and is
// left out of the saved rulebook, so a rulebook without the setting keeps its exact shape and hash.
export const ROUTE_DEFAULT_OPTIONS = [
  { value: 'standard', label: 'Standard provider', help: 'Requests that name no lane go to any eligible provider, as they do today.' },
  { value: 'proven_first', label: 'Proven hardware first', help: 'Proven hardware when the model has an endpoint on it right now, otherwise a standard provider.' },
  { value: 'proven_only', label: 'Proven hardware only', help: 'Only endpoints with a fresh hardware check. When none can serve the request, it is refused and nothing is charged.' },
];
export const ROUTE_DEFAULTS = ROUTE_DEFAULT_OPTIONS.map(o => o.value);
export const ROUTE_DEFAULT_FIRST_NOTE = 'Proven hardware first checks once, before the request is routed: if the model has no proven endpoint for it at that moment, a standard provider answers and the receipt and label show the standard route.';

/** The form value for a stored rulebook. */
export const routeDefaultForm = policy => ROUTE_DEFAULTS.includes(policy?.route_default) ? policy.route_default : 'standard';

/** Adds route_default to a rulebook being built; standard adds nothing. */
export function applyRouteDefault(policy, value, errors) {
  if (!ROUTE_DEFAULTS.includes(value)) { errors.push('Default route: choose Standard provider, Proven hardware first or Proven hardware only.'); return policy; }
  if (value !== 'standard') policy.route_default = value;
  return policy;
}

/** What the lane allowlist does to the chosen default, or '' when they agree. The stricter rule always wins. */
export function routeDefaultConflict(value, restrictLanes, lanes) {
  if (value === 'standard' || !restrictLanes) return '';
  const attested = lanes.includes('attested'), standard = lanes.includes('public');
  if (value === 'proven_only') return attested ? '' : 'The allowed lanes above leave out attested, so requests that name no lane will be refused.';
  if (!attested) return standard ? 'The allowed lanes above leave out attested, so requests that name no lane will use a standard provider.' : 'The allowed lanes above leave out attested and public, so requests that name no lane will be refused.';
  return standard ? '' : 'The allowed lanes above leave out public, so a request whose model has no proven endpoint will be refused.';
}
