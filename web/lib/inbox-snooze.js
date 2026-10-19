// K187: presets use the device's calendar, including daylight-saving transitions.
export function snoozeUntil(choice, now = new Date()) {
  const date = new Date(now);
  if (choice === 'hour') date.setTime(date.getTime() + 3600000);
  else if (choice === 'tomorrow') { date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); }
  else if (choice === 'monday') { date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7)); date.setHours(9, 0, 0, 0); }
  else throw new Error('Choose a snooze time.');
  return date.toISOString();
}
export function snoozeUrl(href, active) {
  const url = new URL(href);
  if (active) url.searchParams.set('snoozed', 'true'); else url.searchParams.delete('snoozed');
  return url.pathname + url.search + url.hash;
}
export const snoozedSelected = search => new URLSearchParams(search).get('snoozed') === 'true';
export function snoozedInboxPage(snapshot, waiting) {
  if (snapshot.seen_scope !== waiting.seen_scope) throw new Error('Your inbox view changed. Refresh to read the current view.');
  // H173 marks the original snapshot, never arrivals during this second request.
  return { ...waiting, as_of: snapshot.as_of };
}
export const snoozePath = id => '/api/v1/inbox/' + encodeURIComponent(id) + '/snooze';
export async function snoozeNotice(request, item, until) { return request(snoozePath(item.id), { method: 'POST', body: { until } }); }
export async function unsnoozeNotice(request, item) { return request(snoozePath(item.id), { method: 'DELETE' }); }
