// Missing or unreachable admission status keeps the page closed.
export async function hostsOpen(fetcher = fetch) {
  try {
    const response = await fetcher("/api/v1/status", { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    return (await response.json())?.data?.network?.hosts_open === true;
  } catch { return false; }
}
