/** Only stable, bounded boolean checks are exposed; never labels from providers or exceptions. */
export function readinessMetrics(result: { ok: boolean; checks: Record<string, boolean>; warnings?: { code: string }[] }): string {
  const lines = [
    "# HELP anyroute_ready Whether every required dependency and worker is ready.",
    "# TYPE anyroute_ready gauge",
    `anyroute_ready ${result.ok ? 1 : 0}`,
    "# HELP anyroute_readiness_check Individual dependency and worker readiness.",
    "# TYPE anyroute_readiness_check gauge",
  ];
  for (const [check, ready] of Object.entries(result.checks).sort(([a], [b]) => a.localeCompare(b))) {
    // Readiness owns these names; reject unexpected labels rather than leaking content.
    if (/^[a-z][a-z_-]{0,63}$/.test(check)) lines.push(`anyroute_readiness_check{check="${check}"} ${ready ? 1 : 0}`);
  }
  const warnings = (result.warnings ?? []).filter((w) => /^[a-z][a-z_-]{0,63}$/.test(w.code));
  if (warnings.length) {
    lines.push("# HELP anyroute_readiness_warning A condition that does not fail readiness but needs an operator's attention (1 while it holds).", "# TYPE anyroute_readiness_warning gauge");
    for (const w of warnings) lines.push(`anyroute_readiness_warning{warning="${w.code}"} 1`);
  }
  return lines.join("\n") + "\n";
}
