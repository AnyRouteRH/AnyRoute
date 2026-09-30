export async function payoutStatus(fetcher = fetch) {
  try {
    const res = await fetcher('/api/v1/status', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { open: false, feeBps: 500 };
    const network = (await res.json())?.data?.network;
    const feeBps = network?.fee_bps;
    return { open: network?.payouts_open === true, feeBps: Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= 2000 ? feeBps : 500 };
  } catch { return { open: false, feeBps: 500 }; }
}
