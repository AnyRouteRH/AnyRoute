// G161: maps optional work hours without changing rulebooks that omit them.
export const WORK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const defaultWorkHours = () => ({ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', time_zone: 'America/New_York', outside: 'refuse' });
export const workHoursForm = policy => policy.work_hours === undefined ? {} : { workHours: structuredClone(policy.work_hours) };
export function applyWorkHours(policy, hours, errors) {
  if (hours == null) return;
  if (!Array.isArray(hours.days) || !hours.days.length || hours.days.length > 7 || new Set(hours.days).size !== hours.days.length || hours.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Work hours: choose at least one day, each day once.');
  if (![hours.start, hours.end].every(t => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) || hours.start === hours.end) errors.push('Work hours: choose different start and end times.');
  let zoneValid = typeof hours.time_zone === 'string' && hours.time_zone.length <= 100 && /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(hours.time_zone);
  try { if (zoneValid) new Intl.DateTimeFormat('en-US', { timeZone: hours.time_zone }); } catch { zoneValid = false; }
  if (!zoneValid) errors.push('Work hours: enter a valid time zone, such as America/New_York or Europe/London.');
  if (!['refuse', 'ask_first'].includes(hours.outside)) errors.push('Outside work hours: choose Refuse or Ask first.');
  policy.work_hours = structuredClone(hours);
}
