// E150: measured catalogue sorts. Unknown readings stay unknown.
export const PERFORMANCE_SORTS = [
  { key: "fastest", label: "Fastest right now" },
  { key: "throughput", label: "Highest throughput" },
  { key: "reliable", label: "Most reliable" },
];
const fields = { fastest: "latency_p50_ms", throughput: "throughput_p50_tps", reliable: "uptime_percent" };
const reading = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function performanceValue(model, sort) {
  const data = model?.performance;
  const value = data?.[fields[sort]];
  if (!reading(value)) return null;
  if (sort === "reliable") return data.uptime_window_days === 30 && data.uptime_observations > 0 && value <= 100 ? value : null;
  return data.speed_window_seconds === 1800 ? value : null;
}
export function comparePerformance(a, b, sort) {
  const first = performanceValue(a, sort), second = performanceValue(b, sort);
  if (first == null) return second == null ? 0 : 1;
  if (second == null) return -1;
  return sort === "fastest" ? first - second : second - first;
}
const number = value => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
export function performanceLabels(model) {
  const latency = performanceValue(model, "fastest"), throughput = performanceValue(model, "throughput"), uptime = performanceValue(model, "reliable");
  return [
    { key: "latency", title: "Fastest measured route", text: latency == null ? "No recent data" : `about ${number(latency / 1000)} s latency in the last 30 minutes` },
    { key: "throughput", title: "Highest measured throughput", text: throughput == null ? "No recent data" : `about ${number(throughput)} tokens per second in the last 30 minutes` },
    { key: "uptime", title: "Observed reliability", text: uptime == null ? "No recent data" : `${number(uptime)}% up in the last 30 days` },
  ];
}

const SORT_KEYS = ["name", "priceIn", "priceOut", "context", ...PERFORMANCE_SORTS.map(option => option.key)];
export function catalogSortFromUrl(href) {
  const sort = new URL(href, "https://anyroute.tech").searchParams.get("sort");
  return SORT_KEYS.includes(sort) ? sort : "name";
}
export function catalogSortUrl(href, sort) {
  const url = new URL(href, "https://anyroute.tech");
  if (SORT_KEYS.includes(sort)) url.searchParams.set("sort", sort);
  else url.searchParams.delete("sort");
  return url.pathname + url.search + url.hash;
}
