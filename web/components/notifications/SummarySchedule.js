'use client';
// K188: edits the existing Notifications form; its Save button persists the schedule and channels together.
import { createElement as h } from 'react';
import { summaryTimeZones } from '../../lib/summary-schedule.js';
export default function SummarySchedule({ value, onChange, styles: s = {} }) {
  const change = patch => onChange({ ...value, ...patch });
  return h('fieldset', { className: s.schedule },
    h('legend', null, 'Summary schedule'),
    h('p', { className: 'help-text', id: 'summary-schedule-hint' }, 'Use the Summary switches above to choose where it arrives. Empty periods are skipped. Telegram waits during quiet hours.'),
    h('div', { className: s.fields },
      h('label', null, 'Send', h('select', { value: value.cadence, onChange: e => change({ cadence: e.target.value }), 'aria-describedby': 'summary-schedule-hint' },
        h('option', { value: 'weekly' }, 'Weekly (Monday)'), h('option', { value: 'daily' }, 'Daily'))),
      h('label', null, 'Hour', h('select', { value: value.hour, onChange: e => change({ hour: Number(e.target.value) }) },
        Array.from({ length: 24 }, (_, hour) => h('option', { key: hour, value: hour }, `${String(hour).padStart(2, '0')}:00`)))),
      h('label', { className: s.zone }, 'Time zone', h('select', { value: value.time_zone, onChange: e => change({ time_zone: e.target.value }) },
        summaryTimeZones(value.time_zone).map(zone => h('option', { key: zone, value: zone }, zone.replaceAll('_', ' '))))),
    ),
    h('p', { className: 'help-text' }, 'Daily covers the previous day. Weekly covers Monday through Sunday. The chosen time zone follows daylight-saving changes. Delivery is checked each hour.'),
  );
}
