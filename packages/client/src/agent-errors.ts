import { AnyRouteError } from "./errors.js";
import type { AgentReason } from "./agent.js";

class AgentRefusal extends AnyRouteError {
  readonly reasons: AgentReason[];
  readonly policy_sha256?: string;
  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message, code, status, details);
    const meta = details as { reasons?: AgentReason[]; policy_sha256?: string } | undefined;
    this.reasons = meta?.reasons ?? [];
    this.policy_sha256 = meta?.policy_sha256;
  }
}
export class AgentPolicyDenied extends AgentRefusal {
  constructor(message: string, status = 403, details?: unknown) { super(message, "agent_policy_denied", status, details); this.name = "AgentPolicyDenied"; }
}
export class AgentKilled extends AgentRefusal {
  constructor(message: string, status = 403, details?: unknown) { super(message, "agent_killed", status, details); this.name = "AgentKilled"; }
}
export class AgentApprovalRequired extends AgentRefusal {
  readonly approval_id?: string;
  readonly poll?: unknown;
  constructor(message: string, status = 403, details?: unknown) {
    super(message, "agent_approval_required", status, details);
    this.name = "AgentApprovalRequired";
    const meta = details as { approval_id?: string; poll?: unknown } | undefined;
    this.approval_id = meta?.approval_id;
    this.poll = meta?.poll;
  }
}
/** Keep the router's message and metadata verbatim; never retry automatically. */
export function requestError(message: string, code: string, status: number, details?: unknown): AnyRouteError {
  switch (code) {
    case "agent_policy_denied": return new AgentPolicyDenied(message, status, details);
    case "agent_killed": return new AgentKilled(message, status, details);
    case "agent_approval_required": return new AgentApprovalRequired(message, status, details);
    default: return new AnyRouteError(message, code, status, details);
  }
}
