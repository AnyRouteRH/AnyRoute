import type { ExternalDoc } from "./types";
// G165: browser-only model picks and public catalogue reads.
export const modelCompareBrowser: ExternalDoc["browser"]["items"][number] = {
  store: "Session storage (anyroute-model-compare-v1)",
  holds: "Up to three public model IDs selected for comparison. Clear picks removes the selection; session storage lasts until the tab closes. Blocked storage falls back to page memory until navigation. Comparison links expose selected IDs in the URL to recipients and ordinary web request handling. Public models, providers and endpoint responses are read without an account key and held in page memory. No prompts, answers, wallet addresses or account secrets are read by comparison code. No new table, column, Redis key family or log field. Ordinary Chat still sends request text that the router reads in memory.",
  evidence: [{ file: "web/lib/model-compare.js", contains: "COMPARE_STORE" }, { file: "web/components/ModelComparePicks.jsx", contains: "window.sessionStorage" }, { file: "web/components/ModelCompare.jsx", contains: "loadModelComparison(ids, api" }],
};
