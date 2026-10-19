export const YOUR_MODELS_PATH = '/api/v1/account/models/used';
export const yourModelsFromUrl = href => new URL(href, 'https://anyroute.tech').searchParams.get('filter') === 'your-models';
export function yourModelsUrl(href, active) {
  const url = new URL(href, 'https://anyroute.tech');
  if (active) url.searchParams.set('filter', 'your-models');
  else if (url.searchParams.get('filter') === 'your-models') url.searchParams.delete('filter');
  return url.pathname + url.search + url.hash;
}
// The batched reader orders by exact net spend; preserve that order through other filters.
export function yourModelsInCatalog(models, report) {
  const catalogue = new Map(models.map(model => [model.id, model]));
  return (report?.data ?? []).flatMap(row => catalogue.has(row.model) ? [catalogue.get(row.model)] : []);
}
