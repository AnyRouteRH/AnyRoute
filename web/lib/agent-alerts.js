export function alertLabel(alert) {
  if (alert.kind === 'cap') return `${alert.percent}% of the rolling ${alert.window} cap`;
  if (alert.kind === 'denials') return `${alert.count} denied request batches in 10 minutes`;
  return ({killed:'Agent stopped',approval:'Agent requested approval'})[alert.kind] || 'Agent alert';
}
export function alertSettingsErrors(alerts) {
  if (alerts === undefined) return [];
  const errors = [];
  if (alerts.at_percent && (alerts.at_percent.length > 64 || alerts.at_percent.some(n => !Number.isInteger(n) || n < 1 || n > 100))) errors.push('Alert percentages must be whole numbers from 1 to 100, at most 64 entries.');
  if (alerts.denials_in_10min !== undefined && (!Number.isInteger(alerts.denials_in_10min) || alerts.denials_in_10min < 1 || alerts.denials_in_10min > 10000)) errors.push('Denial alert count must be a whole number from 1 to 10,000.');
  if (alerts.channels && (alerts.channels.length > 3 || alerts.channels.some(c => !['webhook','email','telegram'].includes(c)))) errors.push('Choose webhook, email or Telegram alert channels.');
  return errors;
}
