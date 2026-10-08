// D141: settings are separate from an agent's rulebook.
export const QUIET_OPTIONS = [null, 1, 3, 6, 12, 24, 72];
export const quietAlertPath = hash => '/api/v1/agents/' + encodeURIComponent(hash) + '/quiet-alert';
export function quietSetting(response) {
  const hours = response?.data?.hours;
  if (!QUIET_OPTIONS.includes(hours)) throw new Error('The quiet alert setting could not be read.');
  return hours;
}
export const quietChoice = value => value === 'off' ? null : Number(value);
