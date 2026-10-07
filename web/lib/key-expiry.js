// C127: dates stay in the existing expires_at field; no browser storage is added.
const DAY = 86_400_000;
export const EXPIRY_OPTIONS = [['never', 'Never'], ['1', 'in 1 day'], ['7', 'in 7 days'], ['30', 'in 30 days'], ['date', 'on a date']];
export const EXPIRY_WARNING = 'This browser will be signed out when it expires';

export function keyHasExpired(value, now = Date.now()) {
  return !!value && Date.parse(value) <= now;
}

export function expiryText(value, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  if (keyHasExpired(value, now)) return 'Expired';
  // Calendar days in this browser, including across daylight-saving changes.
  const calendarDay = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((calendarDay(new Date(value)) - calendarDay(new Date(now))) / DAY);
  return days === 0 ? 'Expires today' : `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function localExpiryDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function earliestExpiryDate(now = Date.now()) {
  const today = new Date(now);
  return localExpiryDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString());
}

export function expiryIso(choice, date, now = Date.now()) {
  if (choice === 'never') return null;
  if (['1', '7', '30'].includes(choice)) return new Date(now + Number(choice) * DAY).toISOString();
  if (choice !== 'date' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a future date.');
  // A chosen date expires at the start of that day in this browser's timezone.
  const selected = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(selected.getTime()) || localExpiryDate(selected.toISOString()) !== date || selected.getTime() <= now) throw new Error('Choose a future date.');
  return selected.toISOString();
}

export function expiryAllowed(existing, caller) {
  return existing ? !existing.team : !!caller && (caller.management || !caller.team);
}

export function expiryPatch({ choice, date, changed, existing, caller, now = Date.now() }) {
  if (!changed || !expiryAllowed(existing, caller)) return {};
  return { expires_at: expiryIso(choice, date, now) };
}

export function expiryKeyFields(key, now) {
  return { active: !key.disabled && !keyHasExpired(key.expires_at, now), expiresAt: key.expires_at, team: key.team };
}

export function withKeyExpiry(request, values) {
  return (path, options) => request(path, values.expires_at === undefined ? options : {
    ...options, body: { ...options.body, expires_at: values.expires_at },
  });
}
