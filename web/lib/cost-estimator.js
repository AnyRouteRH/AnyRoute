import { estimateTokens } from './arena.js';
import { MODEL_CAPABILITIES } from './model-capabilities.js';
import { filterModels } from './model-catalog.js';

// Catalogue USD strings have pico precision. Keep 18 decimal places and never
// round intermediate totals, convert to float, or interpret an absent price as free.
const SCALE = 10n ** 18n;
export const MONTH_DAYS = 30;
export const COST_SIZES = [
  { key: 'question', label: 'A short question' },
  { key: 'document', label: 'A long document' },
  { key: 'code', label: 'A coding task' },
  { key: 'prompt', label: 'Paste your text' },
];
export const COST_SORTS = [
  { key: 'total', label: 'Total · lowest first' },
  { key: 'totalDesc', label: 'Total · highest first' },
  { key: 'name', label: 'Model name' },
];
export const DEFAULT_COST_STATE = { tags: [], size: 'question', pages: 10, input: 100, systemTokens: 0, output: 512, volume: 100, sort: 'total' };
const integer = (value, fallback, max) => {
  const n = Number(value);
  return value !== null && value !== '' && Number.isSafeInteger(n) && n >= 0 && n <= max ? n : fallback;
};
export function costState(value = {}) {
  return {
    tags: MODEL_CAPABILITIES.filter(tag => (value.tags || []).includes(tag.key)).map(tag => tag.key),
    size: COST_SIZES.some(size => size.key === value.size) ? value.size : DEFAULT_COST_STATE.size,
    pages: Math.max(1, integer(value.pages, DEFAULT_COST_STATE.pages, 1000)),
    input: integer(value.input, DEFAULT_COST_STATE.input, 1_000_000),
    systemTokens: integer(value.systemTokens, 0, 1_000_000),
    output: integer(value.output, DEFAULT_COST_STATE.output, 1_000_000),
    volume: integer(value.volume, DEFAULT_COST_STATE.volume, 1_000_000),
    sort: COST_SORTS.some(sort => sort.key === value.sort) ? value.sort : DEFAULT_COST_STATE.sort,
  };
}
export function readCostState(search = '') {
  const params = new URLSearchParams(search);
  return costState({ ...Object.fromEntries(params), tags: (params.get('tags') || '').split(',') });
}
export function costHref(value) {
  const state = costState(value);
  // Whitelist numbers and choices only: neither prompt nor system text is a URL field.
  const params = new URLSearchParams({ size: state.size, output: String(state.output), volume: String(state.volume), sort: state.sort });
  if (state.tags.length) params.set('tags', state.tags.join(','));
  if (state.size === 'document') params.set('pages', String(state.pages));
  if (state.size === 'prompt') params.set('input', String(state.input));
  else if (state.systemTokens) params.set('systemTokens', String(state.systemTokens));
  return '/cost/?' + params;
}
export function costInputTokens(value, prompt, system) {
  const state = costState(value);
  if (state.size === 'prompt') return prompt === undefined ? state.input : estimateTokens([system, prompt].filter(Boolean).join('\n'));
  const characters = state.size === 'document' ? 2000 * state.pages : state.size === 'code' ? 6000 : 400;
  return estimateTokens(' '.repeat(characters)) + (system === undefined ? state.systemTokens : estimateTokens(system));
}

export function decimalUsd(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match || match[1].length + (match[2]?.length || 0) > 40) return null;
  const exponent = Number(match[3] || 0), fraction = match[2] || '';
  const power = 18 + exponent - fraction.length;
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 24 || power < 0 || power > 42) return null;
  return BigInt(match[1] + fraction) * 10n ** BigInt(power);
}
export const perMillionRate = value => {
  const rate = decimalUsd(value);
  return rate === null ? null : rate * 1_000_000n;
};
export function modelCost(model, inputTokens, outputTokens, requestsPerDay) {
  if (![inputTokens, outputTokens, requestsPerDay].every(n => Number.isSafeInteger(n) && n >= 0)) throw new RangeError('Counts must be non-negative whole numbers.');
  const inputRate = decimalUsd(model.pricing?.prompt), outputRate = decimalUsd(model.pricing?.completion);
  const fee = decimalUsd(model.pricing?.request ?? '0');
  const input = inputRate === null ? null : inputRate * BigInt(inputTokens);
  const output = outputRate === null ? null : outputRate * BigInt(outputTokens);
  // A model listing no token prices and no request fee isn't free: it is priced some other way (e.g. per clip). Don't show $0.
  const unlisted = inputRate === 0n && outputRate === 0n && fee === 0n;
  const total = unlisted || input === null || output === null || fee === null ? null : input + output + fee;
  return { input, output, fee, total, monthly: total === null ? null : total * BigInt(requestsPerDay) * BigInt(MONTH_DAYS) };
}
// Round half up at display only. Positive amounts smaller than the display unit
// are shown with '<' rather than silently presented as zero.
export function formatCost(amount, digits = 6) {
  if (amount === null) return 'Price unavailable';
  if (!Number.isInteger(digits) || digits < 0 || digits > 18) throw new RangeError('Invalid precision.');
  if (amount === 0n) return '$0';
  const divisor = 10n ** BigInt(18 - digits), unit = 10n ** BigInt(digits);
  const rounded = (amount + divisor / 2n) / divisor;
  const text = n => `${n / unit}${digits ? '.' + String(n % unit).padStart(digits, '0') : ''}`;
  return rounded === 0n ? '<$' + text(1n) : '$' + text(rounded);
}
export function costRows(models, { query = '', tags = [], sort = 'total', input = 0, output = 512, volume = 100 } = {}) {
  // Chat pricing only: embedding-only models can't answer a prompt (the Harness leaves them out too).
  const chatModels = models.filter(model => !(model.architecture?.output_modalities || []).includes('embeddings'));
  const rows = filterModels(chatModels, { query, tags }).map(model => ({ model, cost: modelCost(model, input, output, volume) }));
  const nameOrder = (a, b) => String(a.model.name || a.model.id).localeCompare(String(b.model.name || b.model.id)) || String(a.model.id).localeCompare(String(b.model.id));
  const cheapest = [...rows].filter(row => row.cost.total !== null).sort((a, b) => a.cost.total < b.cost.total ? -1 : a.cost.total > b.cost.total ? 1 : nameOrder(a, b)).slice(0, 3);
  const highlighted = new Set(cheapest.map(row => row.model.id));
  return rows.sort((a, b) => {
    if (sort === 'name') return nameOrder(a, b);
    if (a.cost.total === null || b.cost.total === null) return a.cost.total === b.cost.total ? nameOrder(a, b) : a.cost.total === null ? 1 : -1;
    const order = a.cost.total < b.cost.total ? -1 : a.cost.total > b.cost.total ? 1 : 0;
    return (sort === 'totalDesc' ? -order : order) || nameOrder(a, b);
  }).map(row => ({ ...row, cheapest: highlighted.has(row.model.id) }));
}
