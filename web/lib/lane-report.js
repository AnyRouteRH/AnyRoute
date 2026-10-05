import { verifyHref } from './verify.js';
// Lane report: where an account's calls ran, by lane, with the share on proven hardware and, for the attested and
// unlinkable lanes, each provider and model with a link to that provider's hardware evidence. GET /api/v1/lane-report.
export const LANE_REPORT_TYPE = 'anyroute.lane-report.v1';
export const PROOF_TIME_HREF = '/status/#proof-time';
export const LANES = [
  { lane: 'public', label: 'Public', proven: false },
  { lane: 'attested', label: 'Attested', proven: true },
  { lane: 'unlinkable', label: 'Unlinkable', proven: true },
];
const DAY_MS = 86400000;
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

export const laneReportPath = ({ from, to }) => '/api/v1/lane-report?' + new URLSearchParams({ from, to });
export const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7);

/** A calendar month as a range of UTC dates: its first day to its last, or to today while the month is running. */
export function monthRange(month, now = new Date()) {
  const [year, number] = String(month).split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10), today = now.toISOString().slice(0, 10);
  return { from: first, to: last > today && first <= today ? today : last };
}

/** A sentence for the first problem with a range, or '' when the router will accept it. */
export function laneReportRangeError({ from, to }, maxDays = 31, now = new Date()) {
  if (!isDate(from) || !isDate(to)) return 'Choose a start and an end date.';
  if (to < from) return 'The end date must be on or after the start date.';
  if (from > now.toISOString().slice(0, 10)) return 'The range starts in the future.';
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  return days > maxDays ? `A lane report covers at most ${maxDays} days. This range has ${days}.` : '';
}

export const laneLabel = lane => LANES.find(item => item.lane === lane)?.label ?? (lane == null ? 'Lane not recorded' : String(lane));

/** 0.3333 as "33.3%", 1 as "100%"; a share with nothing to divide is shown as a dash. */
export function percent(share) {
  if (typeof share !== 'number' || !Number.isFinite(share)) return '–';
  const value = Math.round(share * 1000) / 10;
  return (Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)) + '%';
}

/** The stacked bar for one measure: each lane with a share above zero, in lane order, sized by its share. */
export function laneSegments(report, measure = 'calls') {
  const field = measure === 'spend' ? 'share_of_spend' : 'share_of_calls';
  return (report?.lanes ?? []).filter(row => typeof row[field] === 'number' && row[field] > 0)
    .map(row => ({ lane: row.lane, tone: row.lane ?? 'none', label: laneLabel(row.lane), proven: !!row.proven, share: row[field], text: `${laneLabel(row.lane)} ${percent(row[field])}` }));
}

/** One sentence for the share on proven hardware, by calls and, when anything was charged, by spend. */
export function provenSentence(report) {
  const proven = report?.proven;
  if (!report?.totals?.calls || !proven) return 'No calls in this range.';
  const spend = typeof proven.share_of_spend === 'number' ? ` and ${percent(proven.share_of_spend)} of spend` : '';
  return `${percent(proven.share_of_calls)} of calls${spend} ran on proven hardware.`;
}

/** Evidence links stay on this site: the provider's attestation record on Verify. */
export const evidenceHref = provider => verifyHref(provider);

/** Check the response is a lane report before it is shown. */
export function readLaneReport(value) {
  const report = value?.data ?? value;
  if (report?.type !== LANE_REPORT_TYPE || !report.totals || !report.proven || !Array.isArray(report.lanes) || !Array.isArray(report.providers)) throw new Error('The lane report could not be read.');
  return report;
}
