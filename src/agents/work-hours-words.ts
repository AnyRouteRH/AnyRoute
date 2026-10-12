// G161: pure sentences, also generated into web/lib/work-hours-words.js.
import type { WorkHours } from './work-hours.ts';
export function workHoursSentence(hours: WorkHours): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const days = [...hours.days].sort((a, b) => a - b);
  const schedule = days.join(',') === '1,2,3,4,5' ? 'Monday to Friday' : days.length === 7 ? 'every day' : days.map(d => names[d]).join(', ');
  const zone = hours.time_zone === 'UTC' ? 'UTC' : hours.time_zone.split('/').at(-1)!.replaceAll('_', ' ') + ' time';
  return `Works ${schedule}, ${hours.start.replace(/^0/, '')} to ${hours.end.replace(/^0/, '')} ${zone}${hours.start > hours.end ? ' (ends the following day)' : ''}; ${hours.outside === 'ask_first' ? 'asks first' : 'refuses requests'} outside those hours`;
}
