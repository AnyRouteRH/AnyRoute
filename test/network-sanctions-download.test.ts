import { expect, test } from "bun:test";
import { DEFAULT_SANCTIONS_LIST_URL, sanctionsSettings } from "../src/network/config.ts";
import { fetchSanctionsList, isSanctionsHost } from "../src/network/sanctions-download.ts";

const signed = "https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/SDN.XML?signature=fixture";

test("allows only exact OFAC hosts and the specified S3 suffix", () => {
  for (const host of ["sanctionslistservice.ofac.treas.gov", "www.treasury.gov", "treasury.gov", "ofac.treasury.gov", new URL(signed).hostname]) expect(isSanctionsHost(host)).toBe(true);
  for (const host of ["example.com", "treasury.gov.example.com", "eviltreasury.gov", "s3.us-gov-west-1.amazonaws.com", "bucket.s3.us-gov-west-1.amazonaws.com.example.com"]) expect(isSanctionsHost(host)).toBe(false);
});

test("follows at most three redirects with one shared deadline and manual fetches", async () => {
  const signals: AbortSignal[] = [], urls: string[] = [];
  let cancelled = 0;
  const fetcher = (async (input, init) => {
    urls.push(String(input));
    signals.push(init!.signal!);
    expect(init!.redirect).toBe("manual");
    const location = ["/next", "https://www.treasury.gov/ofac/downloads/sdn.xml", signed][urls.length - 1];
    return location ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location } }) : new Response("SDN XML");
  }) as typeof fetch;
  const response = await fetchSanctionsList(DEFAULT_SANCTIONS_LIST_URL, true, fetcher);
  expect(await response.text()).toBe("SDN XML");
  expect(urls).toEqual([DEFAULT_SANCTIONS_LIST_URL, "https://sanctionslistservice.ofac.treas.gov/next", "https://www.treasury.gov/ofac/downloads/sdn.xml", signed]);
  expect(signals.length).toBe(4);
  expect(signals.every((s) => s === signals[0])).toBe(true);
  expect(cancelled).toBe(3);
});

for (const status of [301, 302, 303, 307, 308]) test(`accepts HTTPS allowlisted redirect status ${status}`, async () => {
  let calls = 0;
  const fetcher = (async () => ++calls === 1 ? new Response(null, { status, headers: { location: signed } }) : new Response("SDN XML")) as typeof fetch;
  expect(await (await fetchSanctionsList(DEFAULT_SANCTIONS_LIST_URL, true, fetcher)).text()).toBe("SDN XML");
  expect(calls).toBe(2);
});

test("rejects invalid initial URLs before making a request; localhost is allowed only outside production", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response("SDN XML"); }) as typeof fetch;
  for (const url of ["https://example.com/sdn.xml", "http://treasury.gov/sdn.xml", "https://user:password@treasury.gov/sdn.xml", "http://localhost/sdn.xml"]) await expect(fetchSanctionsList(url, true, fetcher)).rejects.toThrow();
  expect(calls).toBe(0);
  await fetchSanctionsList("http://localhost/sdn.xml", false, fetcher);
  expect(calls).toBe(1);
});

test("production settings default to OFAC and reject unsafe URLs even with screening disabled", () => {
  for (const enabled of [true, false]) {
    const env = { SANCTIONS_SCREENING_ENABLED: enabled, SANCTIONS_MAX_AGE_DAYS: 7 };
    expect(sanctionsSettings(env, true).listUrl).toBe(DEFAULT_SANCTIONS_LIST_URL);
    for (const url of ["https://example.com/sdn.xml", "http://localhost/sdn.xml", "https://user@treasury.gov/sdn.xml", "https://treasury.gov/sdn.xml#fragment"]) expect(() => sanctionsSettings({ ...env, SANCTIONS_LIST_URL: url }, true)).toThrow();
    expect(sanctionsSettings({ ...env, SANCTIONS_LIST_URL: "http://localhost/sdn.xml" }, false).listUrl).toBe("http://localhost/sdn.xml");
    expect(() => sanctionsSettings({ ...env, SANCTIONS_LIST_URL: "http://example.com/sdn.xml" }, false)).toThrow();
  }
});
