const OFAC_HOSTS = new Set([
  "sanctionslistservice.ofac.treas.gov",
  "www.treasury.gov",
  "treasury.gov",
  "ofac.treasury.gov",
]);

export function isSanctionsHost(hostname: string): boolean {
  return OFAC_HOSTS.has(hostname) || hostname.endsWith(".s3.us-gov-west-1.amazonaws.com");
}

function assertDownloadUrl(url: URL, allowLocal: boolean): void {
  if (url.username || url.password || url.hash) throw new Error("SDN URL contains credentials or a fragment");
  if (allowLocal && url.hostname === "localhost" && url.protocol === "http:") return;
  if (url.protocol !== "https:" || !isSanctionsHost(url.hostname)) throw new Error("SDN URL must use HTTPS and an allowed host");
}

/** One deadline covers the entire download, including redirects and the final response stream.
 * Signed locations are used only in memory; no URL or error containing one is logged or retained.
 */
export async function fetchSanctionsList(listUrl: string, production: boolean, fetcher: typeof fetch): Promise<Response> {
  let url = new URL(listUrl);
  assertDownloadUrl(url, !production);
  const signal = AbortSignal.timeout(60_000);
  for (let hops = 0; ; hops++) {
    const response = await fetcher(url.toString(), { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    // Release intermediate streams even when the location or hop count is rejected.
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (hops >= 3 || !location) throw new Error("SDN redirect limit or missing location");
    const next = new URL(location, url);
    assertDownloadUrl(next, false);
    url = next;
  }
}
