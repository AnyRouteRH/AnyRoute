// H170: plain sentences only; estimates never promise an enforcement time.
const dollars = value => '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const periods = { hour: 'hour', day: 'day', week: 'week', month: 'month', total: 'total' };
export function agentRunwayLines(data) {
  const zone = data.time_zone;
  const lines = [`Today: ${dollars(data.today_charged_usd)} charged · ${zone}.`];
  if (!data.limits.length) return [...lines, 'No caps set.'];
  for (const limit of data.limits) {
    if (limit.period === 'request') { lines.push(`Per request cap: ${dollars(limit.cap_usd)}.`); continue; }
    const label = limit.source === 'rulebook' ? `Rolling ${periods[limit.period]} cap` : `${limit.period === 'total' ? 'Total' : 'Calendar ' + periods[limit.period]} key budget`;
    let estimate;
    if (limit.remaining_usd === 0) estimate = 'Charged spend has reached this cap.';
    else if (limit.estimated_days_left === null) estimate = 'No spending pace yet to estimate how long it lasts.';
    else if (limit.resets_at && limit.reaches_before_reset === false) estimate = 'Estimate: at this pace, it lasts until the next UTC reset.';
    else if (limit.period === 'day' || limit.period === 'hour') {
      const time = limit.estimated_reaches_at && new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(limit.estimated_reaches_at));
      estimate = time ? `Estimate: at this pace, the remaining amount runs out around ${time} (${zone}).` : 'Estimate: more than a year remaining at this pace.';
    } else {
      const days = limit.estimated_days_left;
      estimate = days < 1 ? 'Estimate: lasts less than one more day at your 7-day pace.' : `Estimate: lasts about ${Math.max(1, Math.round(days))} more days at your 7-day pace.`;
    }
    lines.push(`${label}: ${dollars(limit.charged_usd)} of ${dollars(limit.cap_usd)} charged. ${estimate}`);
  }
  return lines;
}
