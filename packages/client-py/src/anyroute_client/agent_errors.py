"""Router refusals with unchanged messages and metadata; no automatic retry."""
from typing import Any
from .errors import AnyRouteError


class _AgentRefusal(AnyRouteError):
    code_name = ""

    def __init__(self, message: str, status: int = 403, details: Any = None):
        super().__init__(message, self.code_name, status, details)
        meta = details if isinstance(details, dict) else {}
        self.reasons = meta.get("reasons", [])
        self.policy_sha256 = meta.get("policy_sha256")


class AgentPolicyDenied(_AgentRefusal):
    code_name = "agent_policy_denied"


class AgentKilled(_AgentRefusal):
    code_name = "agent_killed"


class AgentApprovalRequired(_AgentRefusal):
    code_name = "agent_approval_required"

    def __init__(self, message: str, status: int = 403, details: Any = None):
        super().__init__(message, status, details)
        meta = details if isinstance(details, dict) else {}
        self.approval_id = meta.get("approval_id")
        self.poll = meta.get("poll")


def request_error(message: str, code: str, status: int, details: Any = None) -> AnyRouteError:
    kind = {"agent_policy_denied": AgentPolicyDenied, "agent_killed": AgentKilled, "agent_approval_required": AgentApprovalRequired}.get(code)
    return kind(message, status, details) if kind else AnyRouteError(message, code, status, details)
