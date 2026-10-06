export const WEEKLY_SUMMARY_PATH = '/api/v1/telegram/weekly-summary';
export async function readWeeklySummaryPreference(request, options = {}) {
  return preference((await request(WEEKLY_SUMMARY_PATH, options))?.data);
}
export async function setWeeklySummaryPreference(request, optedIn, options = {}) {
  return preference((await request(WEEKLY_SUMMARY_PATH, { ...options, method: 'PUT', body: { opted_in: optedIn } }))?.data);
}
function preference(data) {
  if (typeof data?.opted_in !== 'boolean' || (data.last_sent_week !== null && !/^\d{4}-W\d{2}$/.test(data.last_sent_week || ''))) throw new Error('Weekly summary setting could not be read.');
  return data;
}
