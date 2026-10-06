// B118: an opt-in rulebook save using existing storage and event fields.
export const approveAndAllowBodyReader = {
  file: "src/api/agent-approve-and-allow.ts", carries: "settings" as const,
  reads: "A strict confirmation body containing only the 64-character SHA-256 of the rulebook reviewed by the principal.",
  then: "Checks approval owner/admin scope, original amount-only decision reasons, current rulebook hash and pending status. Approves once and raises only that agent's ask-first amount in one account-locked transaction; playbook followers are refused.",
  kept: "The updated rulebook, its schema version, digest, principal key hash and update time in existing agent_policies; policy_set and approval_approved events in existing agent_policy_events; decision status, actor and time in existing agent_approvals, plus the existing approval webhook when configured. No new tables, columns, Redis families, log fields or address readers. The confirmation hash is checked in memory and is not separately persisted. Ordinary request text remains readable by the router in memory.",
  evidence: [{ file: "src/api/agent-approve-and-allow.ts", contains: "confirmBody.parse(await readJson(c))" }],
};
