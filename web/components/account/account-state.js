import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS } from '../../lib/site-map.js';
export const dashboardSections = ACCOUNT_SECTIONS.filter(section => section.hash);
// U104: the sections of each account tab, in order, and the tab a section belongs to (Overview when unknown).
export const groupSections = group => group.ids.map(id => ACCOUNT_SECTIONS.find(section => section.taskId === id));
export const groupOf = title => ACCOUNT_GROUPS.find(group => groupSections(group).some(section => section.title === title)) || ACCOUNT_GROUPS[0];
// A tab id used as a hash (#overview, #build, #keys, #billing, #settings) opens that tab's first dashboard section.
export const groupHash = id => { const group = ACCOUNT_GROUPS.find(item => item.id === id); return group ? groupSections(group).find(section => section.hash)?.hash : undefined; };
export const sectionFromHash = hash => {
  const id = hash.replace(/^#/, '');
  const target = dashboardSections.some(section => section.hash === id) ? id : groupHash(id);
  return dashboardSections.find(section => section.hash === target)?.title || 'Home';
};
export const sectionHash = title => dashboardSections.find(section => section.title === title)?.hash || 'home';
export function homeChecklist(workspace, agents) {
  return [
    { id: 'funds', title: 'Add funds', href: '/dashboard/#payments', done: Number(workspace.credits?.total_credits) > 0 },
    { id: 'key', title: 'Make a key', href: '/dashboard/#api-keys', done: !!workspace.me?.hash || workspace.keys?.some(key => !key.disabled) },
    { id: 'chat', title: 'Try the chat', href: '/harness/', done: workspace.receipts?.length > 0 || Number(workspace.credits?.total_usage) > 0 },
    { id: 'agent', title: 'Give an agent a budget', href: '/agents/', done: agents?.some(agent => agent.has_policy && Object.values(agent.caps || {}).some(cap => Number(cap) > 0)) },
  ].filter(step => !step.done);
}
export function homeSpend(report) {
  if (!report?.as_of || !Array.isArray(report.series)) return null;
  const monday = new Date(report.as_of); monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const from = monday.toISOString().slice(0, 10);
  const to = report.as_of.slice(0, 10);
  return { today: report.totals.today_usd, week: report.series.filter(day => day.date >= from && day.date <= to).reduce((sum, day) => sum + day.cost_usd, 0), scope: report.scope };
}
