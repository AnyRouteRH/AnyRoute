export const NOTIFICATION_PATH = '/api/v1/account/notifications';
export const NOTICE_ROWS = [
  ['approvals', 'Approvals'], ['agent_alerts', 'Agent alerts'], ['deposits', 'Deposits credited'], ['low_balance', 'Low balance'], ['weekly_summary', 'Weekly summary'], ['security_alerts', 'Security alerts'], ['quiet_agents', 'Quiet agents'], ['price_notices', 'Model rate changes'], ['project_budgets', 'Project budgets'], ['scheduled_results', 'Scheduled prompt results'],
];
const clock = minutes => { const value = (minutes % 1440 + 1440) % 1440; return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; };
const minutes = time => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a valid time.'); return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); };
export const localToUtc = (time, offset = new Date().getTimezoneOffset()) => clock(minutes(time) + offset);
export const utcToLocal = (time, offset = new Date().getTimezoneOffset()) => clock(minutes(time) - offset);
export async function readNotifications(request, options) { return (await request(NOTIFICATION_PATH, options)).data; }
export async function saveNotifications(request, value, options) { return (await request(NOTIFICATION_PATH, { ...options, method: 'PUT', body: { channels: value.channels, quiet_hours: value.quiet_hours } })).data; }
