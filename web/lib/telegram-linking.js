export const TELEGRAM_LINK_PATH = '/api/v1/telegram/link';
export async function readTelegramLink(request, options = {}) {
  const response = await request(TELEGRAM_LINK_PATH, options);
  if (typeof response?.data?.linked !== 'boolean') throw new Error('Telegram link status could not be read.');
  return response.data;
}
export async function issueTelegramLink(request) {
  const response = await request(TELEGRAM_LINK_PATH, { method: 'POST' });
  const { code, expires_at } = response?.data || {};
  if (!/^[A-Za-z0-9_-]{16}$/.test(code || '') || !Number.isFinite(Date.parse(expires_at))) throw new Error('Telegram link code could not be read.');
  return { code, expires_at };
}
export const unlinkTelegram = request => request(TELEGRAM_LINK_PATH, { method: 'DELETE' });
