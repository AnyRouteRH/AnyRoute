export const ROLES = [["host_gpu", "Host (GPU)"], ["host_cpu", "Host (CPU only)"], ["relay", "Relay operator"], ["witness", "Witness"], ["developer", "Developer who needs private capacity"]];
export const REGIONS = [["africa", "Africa"], ["antarctica", "Antarctica"], ["asia", "Asia"], ["europe", "Europe"], ["north_america", "North America"], ["oceania", "Oceania"], ["south_america", "South America"]];
export const PAYOUTS = [["usdg", "USDG"], ["anyr", "$ANYR"], ["any", "No preference"]];
export const PRIVACY_PROMISE = "We keep only what you type here, to count interest and contact you if you asked us to. We don't store your IP address. We delete the list when the program launches or is cancelled.";
const length = (s) => s.length;
export function validateWaitlist(v) {
  const errors = {};
  for (const [key, options] of [["role", ROLES], ["region", REGIONS], ["paid_in", PAYOUTS]]) if (!options.some(([id]) => id === v[key])) errors[key] = "Choose an option.";
  for (const [key, max] of [["hardware", 200], ["readiness", 300], ["contact", 120], ["website", 200]]) if (typeof v[key] !== "string" || length(v[key]) > max) errors[key] = `Use at most ${max} characters.`;
  return errors;
}
export async function submitWaitlist(v, fetcher = fetch) {
  if (Object.keys(validateWaitlist(v)).length) throw new Error("Please check the form fields.");
  const response = await fetcher("/api/v1/network/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v), cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(response.status === 429 ? "Too many requests. Please try again later." : "Your sign-up could not be saved. Please try again.");
  const data = await response.json();
  if (!/^[0-9a-f-]{36}$/.test(data.id || "") || !/^[0-9a-f]{64}$/.test(data.delete_code || "")) throw new Error("The server did not provide a delete code. Please try again.");
  return data;
}
export async function deleteWaitlist(id, delete_code, fetcher = fetch) {
  const response = await fetcher(`/api/v1/network/waitlist/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete_code }), cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(response.status === 404 ? "No entry matched that id and code." : "Deletion could not be completed. Please try again later.");
}
