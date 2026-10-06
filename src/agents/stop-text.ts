// B117: use the deadline captured with the alert, even if the policy has since resumed.
export function timedAlertText(alert: { kind: string; stopped_until?: string; key_hash: string }) {
  return alert.kind === "killed" && alert.stopped_until ? `Anyroute agent stopped until ${alert.stopped_until}. Key ${alert.key_hash}. New requests resume after that time; other rules still apply. Open /agents for details.` : undefined;
}
