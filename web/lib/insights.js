export function insightsPath({ from, to, bucket = 'day', project }) {
  const query = new URLSearchParams({ bucket });
  if (project) query.set('project', project); // C134
  if (from) query.set('from', from + 'T00:00:00Z');
  if (to) query.set('to', to + 'T00:00:00Z');
  return '/api/v1/insights?' + query;
}
export function initialInsightRange(now = new Date()) {
  const to = new Date(now); to.setUTCHours(0,0,0,0); to.setUTCDate(to.getUTCDate()+1);
  return { from: new Date(to.getTime()-30*86400000).toISOString().slice(0,10), to: to.toISOString().slice(0,10), bucket:'day' };
}
export function insightSeries(report) {
  const rows = new Map(report.series.map(row => [row.id,row]));
  const date = new Date(report.from); date.setUTCHours(0,0,0,0);
  if (report.bucket === 'week') date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
  const result = [];
  for (; date.getTime() < Date.parse(report.to); date.setUTCDate(date.getUTCDate()+(report.bucket==='week'?7:1))) {
    const id = date.toISOString().slice(0,10);
    result.push(rows.get(id) || { id, cost_usd:'0', calls:'0', charged_usd:'0', refunded_usd:'0' });
  }
  return result;
}
// Only the SVG converts decimal strings to numbers. Tables retain exact API amounts.
export function insightBars(rows, width = 640, height = 180) {
  const values = rows.map(row => Number(row.cost_usd));
  const low = Math.min(0,...values), high = Math.max(0,...values), span = high-low || 1;
  const y = value => 12+(high-value)/span*(height-36);
  const step = (width-24)/Math.max(1,rows.length), zero = y(0);
  return { zero, width, height, bars: rows.map((row,i) => ({ id:row.id, amount:row.cost_usd, x:12+i*step, y:Math.min(zero,y(values[i])), width:Math.max(1,step*.72), height:Math.abs(zero-y(values[i])) })) };
}
export function provenShare(totals) {
  const calls = BigInt(totals.calls); return calls ? (Number(BigInt(totals.proven_calls)*1000n/calls)/10).toFixed(1)+'%' : 'No calls';
}
