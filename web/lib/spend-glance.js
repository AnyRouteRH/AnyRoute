// C132: plain-language charged-spend summaries and dependency-free SVG geometry.
export const SPEND_GLANCE_PATH = '/api/v1/agents/spend?days=7';
export function spendPage(response) {
  if (response?.days !== 7 || !Array.isArray(response?.data)) throw new Error('Spend could not be read.');
  const rows = {};
  for (const row of response.data) {
    if (typeof row?.key_hash !== 'string' || !Array.isArray(row.daily) || row.daily.length !== 7 ||
      row.daily.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day?.date) || !Number.isFinite(day.charged_usd) || day.charged_usd < 0) ||
      !Number.isFinite(row.total_usd) || row.total_usd < 0) throw new Error('Spend could not be read.');
    rows[row.key_hash] = row;
  }
  return rows;
}
export function spendMoney(amount) {
  return amount > 0 && amount < 0.01 ? 'less than $0.01' : '$' + amount.toFixed(2);
}
export function lastCallText(at, now = Date.now()) {
  if (!at || !Number.isFinite(Date.parse(at))) return '';
  const elapsed = Math.max(0, now - Date.parse(at));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'last call just now';
  if (minutes < 60) return `last call ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last call ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `last call ${days} ${days === 1 ? 'day' : 'days'} ago`;
}
export function spendText(row, now = Date.now()) {
  const thisWeek = row.total_usd > 0 || (row.last_request_at && Date.parse(row.last_request_at) >= Date.parse(row.daily[0].date + 'T00:00:00Z'));
  if (!thisWeek) return 'No calls this week';
  const top = row.top_model;
  const model = top?.name ? `${top.charged_usd > row.total_usd / 2 ? 'mostly' : 'top model'} ${top.name}` : '';
  return [spendMoney(row.total_usd) + ' this week', model, lastCallText(row.last_request_at, now)].filter(Boolean).join(' · ');
}
export function spendBars(daily) {
  const max = Math.max(0, ...daily.map(day => day.charged_usd));
  return daily.map((day, i) => {
    const height = max > 0 ? day.charged_usd / max * 22 : 0;
    return { ...day, x: i * 10, y: 24 - height, width: 6, height, label: `${day.date} UTC: ${spendMoney(day.charged_usd)}` };
  });
}
