// G161: extends existing configuration and decision disclosures; no new reader or store.
import type { TableDoc } from './types.ts';
export function describeWorkHours(tables: Record<string, TableDoc>) {
  const note = 'G161: Optional work_hours keeps selected weekdays, local start/end clocks, an Intl-validated IANA time zone and refuse/ask_first mode in the existing readable rulebook JSON. Current rules, playbook copies and saved history retain it under their existing retention rules. No new table, column, Redis family, log field or request-body/address reader. The router still reads ordinary request text in memory.';
  for (const name of ['agent_policies', 'playbooks', 'playbook_changes', 'policy_versions']) tables[name].notes = [...(tables[name].notes ?? []), note];
  const reasons = tables.agent_policy_events.columns.reasons;
  if (typeof reasons !== 'string') {
    reasons.purpose += ' G161: outside_work_hours and approval_work_hours messages include the computed next opening, its UTC instant and the owner-selected validated time zone.';
    if (reasons.review) reasons.review.why = reasons.review.why.replace('Only evaluator-defined codes and constant messages are stored.', 'Only evaluator-defined codes and router-written messages are stored.') + ' Work-hour messages also contain a derived date and validated time zone configuration; they do not contain inference text.';
  }
}
