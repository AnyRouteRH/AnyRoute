// J182: command replies only; the existing linked-chat authority and delivery path are unchanged.
export function spendActivityUrl(hash: string, from: string, asOf: string) {
  const to = new Date(asOf).toISOString().replace(/(\d{3})Z$/, (_, digits) => digits + "001Z");
  return "https://anyroute.tech/dashboard/?" + new URLSearchParams({ kind: "call", key: hash, from, to, basis: "charges" }) + "#activity";
}
export function spendWebLinks(top: { name: string; activity_url?: string }[]) {
  return top.filter(agent => agent.activity_url).map(agent => `\n${agent.name} · View on the web: ${agent.activity_url}`).join("");
}
