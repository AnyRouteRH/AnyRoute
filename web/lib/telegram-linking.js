export const TELEGRAM_LINK_PATH = '/api/v1/telegram/link';
export async function readTelegramLink(request, options = {}) {
  const response = await request(TELEGRAM_LINK_PATH, options);
  if (typeof response?.data?.linked !== 'boolean') throw new Error('Telegram link status could not be read.');
  return response.data;
}
export async function issueTelegramLink(request) {
  const response = await request(TELEGRAM_LINK_PATH, { method: 'POST' });
  const { code, expires_at, bot_username, link_url } = response?.data || {};
  if (!/^[A-Za-z0-9_-]{16}$/.test(code || '') || !Number.isFinite(Date.parse(expires_at))) throw new Error('Telegram link code could not be read.');
  const bot = botUsername(bot_username);
  return { code, expires_at, ...(bot ? { bot_username: bot, link_url: link_url === `https://t.me/${bot}?start=link-${code}` ? link_url : null } : {}) };
}
// The bot's public @username when the router reports one; anything unexpected is ignored.
export const botUsername = value => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value) ? value : null);
export const unlinkTelegram = request => request(TELEGRAM_LINK_PATH, { method: 'DELETE' });
