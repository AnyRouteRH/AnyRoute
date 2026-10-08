export const SECURITY_ALERTS_PATH = '/api/v1/account/security-alerts';
const preference = result => {
  if (typeof result?.data?.enabled !== 'boolean') throw new Error('Security alerts could not be read.');
  return result.data;
};
export async function readSecurityAlerts(request, options = {}) { return preference(await request(SECURITY_ALERTS_PATH, options)); }
export async function saveSecurityAlerts(request, enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether security alerts are on.');
  return preference(await request(SECURITY_ALERTS_PATH, { ...options, method: 'PATCH', body: { enabled } }));
}
