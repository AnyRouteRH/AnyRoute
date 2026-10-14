// H173: a read approval still needs a decision, but no longer adds to the unread badge.
export function applyInboxReadTime(page, since) {
  if (!since) return page;
  const data = page.data.map(item => item.kind === 'approval' && Date.parse(item.at) <= Date.parse(since) ? { ...item, unread: false } : item);
  return { ...page, data, count: data.filter(item => item.unread).length };
}
