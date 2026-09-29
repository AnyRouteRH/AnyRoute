// Sends one clearly labelled synthetic alert to ALERT_WEBHOOK_URL to prove delivery end to end.
// No check changes state and nothing else is contacted. The URL is a secret and is never printed.
//   With the worker's Railway variables: railway run --service worker bun scripts/alert-drill.ts
//   Directly: ALERT_WEBHOOK_URL=... [ALERT_WEBHOOK_FORMAT=ntfy|slack|discord|json] bun scripts/alert-drill.ts
import { deliverAlert, resolveFormat, type AlertFormat } from "../src/services/alerts.ts";

const FORMATS = ["ntfy", "slack", "discord", "json"] as const;

export async function runAlertDrill(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch, now = new Date()) {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return { code: 2, line: { ok: false, error: "ALERT_WEBHOOK_URL is not set; nothing was sent." } };
  let protocol = "";
  try { protocol = new URL(url).protocol; } catch { /* reported below */ }
  if (protocol !== "https:") return { code: 2, line: { ok: false, error: "ALERT_WEBHOOK_URL must be an https URL; nothing was sent." } };
  const explicit = env.ALERT_WEBHOOK_FORMAT?.trim();
  if (explicit && !FORMATS.includes(explicit as AlertFormat)) return { code: 2, line: { ok: false, error: "ALERT_WEBHOOK_FORMAT must be ntfy, slack, discord or json." } };
  const format = resolveFormat(url, (explicit || undefined) as AlertFormat | undefined);
  const at = now.toISOString();
  const env_ = env.ANYROUTE_ENV && /^[a-z]{1,16}$/.test(env.ANYROUTE_ENV) ? env.ANYROUTE_ENV : "production";
  const result = await deliverAlert(url, format, { kind: "test", environment: env_, at, transitions: [{ check: "alert_delivery", state: "test", since: at }] }, fetchImpl);
  return result.ok
    ? { code: 0, line: { ok: true, format, status: result.status, sent_at: at } }
    : { code: 1, line: { ok: false, format, status: result.status, error: "The webhook did not accept the drill alert." } };
}

if (import.meta.main) {
  const { code, line } = await runAlertDrill(process.env);
  (code === 0 ? console.log : console.error)(JSON.stringify(line));
  process.exit(code);
}
