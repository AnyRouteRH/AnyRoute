const count = value => Number.isSafeInteger(value) && value >= 0;
const units = value => typeof value === "string" && /^\d+$/.test(value);
export function validNetworkStats(data) {
  if (!data || !Number.isFinite(Date.parse(data.as_of)) || !data.hosts || !data.capacity || !data.interest || !data.tokens?.public_lane) return false;
  if (![data.hosts.total, data.hosts.probation, data.hosts.live, data.hosts.rejected, data.attested_hosts, data.capacity.model_count, data.interest.total].every(count)) return false;
  if (data.policy_version !== null && (!count(data.policy_version) || data.policy_version < 1)) return false;
  for (const range of [data.tokens.public_lane.days_7, data.tokens.public_lane.days_30]) {
    if (range !== null && (!units(range?.lower) || !units(range?.upper_exclusive) || BigInt(range.upper_exclusive) <= BigInt(range.lower))) return false;
  }
  if (data.bonds !== null && (!units(data.bonds?.total_units) || !units(data.bonds?.active_units) || data.bonds.decimals !== 6 || data.bonds.asset !== "USDG" || typeof data.bonds.fresh !== "boolean")) return false;
  return true;
}

export async function fetchNetworkStats(fetcher = fetch, signal) {
  try {
    const response = await fetcher("/api/v1/network/stats", { credentials: "omit", cache: "no-store", signal });
    if (!response.ok) return null;
    const { data } = await response.json();
    return validNetworkStats(data) ? data : null;
  } catch { return null; }
}

const number = value => Number(value).toLocaleString("en-US");
const bondValue = value => {
  const n = BigInt(value);
  return `${(n / 1_000_000n).toLocaleString("en-US")}${n % 1_000_000n ? `.${(n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")}` : ""}`;
};
export function networkStatCards(data) {
  const scalar = (label, value) => ({ label, value: value ?? null, text: value == null ? "No data yet" : number(value) });
  const tokens = (label, range) => ({ label, value: null, text: range ? `${BigInt(range.lower).toLocaleString("en-US")}–${(BigInt(range.upper_exclusive) - 1n).toLocaleString("en-US")}` : "No data yet" });
  const bond = (label, key) => ({ label, value: null, text: data?.bonds?.fresh ? bondValue(data.bonds[key]) : "No data yet", unit: "USDG" });
  return [scalar("Network hosts", data?.hosts.total), scalar("Attested hosts", data?.attested_hosts),
    scalar("Models on admitted hosts", data?.capacity.model_count), scalar("Waitlist interest", data?.interest.total),
    tokens("Public-lane tokens · 7 days", data?.tokens.public_lane.days_7), tokens("Public-lane tokens · 30 days", data?.tokens.public_lane.days_30),
    ...(data?.bonds == null ? [] : [bond("Total indexed bonds", "total_units"), bond("Active indexed bonds", "active_units")])];
}
