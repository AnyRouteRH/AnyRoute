// K188: only the browser supplies the initial zone; unsaved accounts retain the server's UTC schedule.
export function initialSummarySchedule(saved, zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  return saved ?? { cadence: 'weekly', hour: 9, time_zone: zone };
}
export function summaryTimeZones(zone) {
  return [...new Set([zone, 'UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? [])])].sort();
}
