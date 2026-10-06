// B117: construct presets in the browser's local timezone, then send an absolute ISO time.
export const STOP_PRESETS = [['hour', 'Stop for 1 hour'], ['tomorrow', 'Stop until tomorrow 9:00'], ['manual', 'Stop until I resume']];
export function stopUntil(preset, now = new Date()) {
  if (preset === 'manual') return undefined;
  if (preset === 'hour') return new Date(now.getTime() + 3_600_000).toISOString();
  if (preset === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow.toISOString();
  }
  throw new Error('Choose a stop duration.');
}
export function stoppedLabel(until, now = new Date()) {
  if (!until) return 'Stopped until you resume';
  const at = new Date(until), time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  const day = days === 0 ? '' : days === 1 ? 'tomorrow ' : at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ';
  return `Stopped until ${day}${time}`;
}
export const stopHelp = 'Stop new requests through Anyroute for a while or until you resume. Requests already running may finish. Other rules still apply after resuming.';
