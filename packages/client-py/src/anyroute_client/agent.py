"""Read and check the calling key's rulebook. Dry runs reserve no budget."""
from typing import Any, Callable, Literal, TypedDict, Union
import httpx
from .agent_errors import request_error

AgentLane = Literal["public", "attested", "unlinkable"]


class AgentNames(TypedDict, total=False):
    allow: list[str]
    deny: list[str]


class AgentCaps(TypedDict, total=False):
    per_request_usd: float
    per_hour_usd: float
    per_day_usd: float
    per_week_usd: float
    max_output_tokens: int


class AgentWindow(TypedDict):
    days: list[Literal[0, 1, 2, 3, 4, 5, 6]]
    start: str
    end: str


class _AgentApprovalOptional(TypedDict, total=False):
    above_calls_per_hour: int


class AgentApproval(_AgentApprovalOptional):
    above_usd: float


class _PolicyOptional(TypedDict, total=False):
    lanes: list[AgentLane]
    tools: AgentNames
    windows: list[AgentWindow]
    approval: AgentApproval


class AgentPolicy(_PolicyOptional):
    version: Literal[1]
    models: AgentNames
    caps: AgentCaps
    on_breach: Literal["deny", "kill"]


class _InferenceOptional(TypedDict, total=False):
    max_output_tokens: int


class AgentInferenceIntent(_InferenceOptional):
    kind: Literal["inference"]
    model: str
    lane: AgentLane
    est_cost_pico: str
    tools: list[str]


class AgentToolIntent(TypedDict):
    kind: Literal["mcp_tool"]
    name: str


AgentIntent = Union[AgentInferenceIntent, AgentToolIntent]


class AgentReason(TypedDict):
    code: Literal["killed", "model_not_allowed", "lane_not_allowed", "over_per_request", "over_per_hour", "over_per_day", "over_per_week", "max_tokens", "tool_not_allowed", "outside_window", "approval_required", "approval_calls_per_hour"]
    message: str


class AgentDecision(TypedDict):
    decision: Literal["allow", "deny", "approval_required"]
    reasons: list[AgentReason]


class AgentRemaining(TypedDict):
    hour: float | None
    day: float | None
    week: float | None


class AgentPolicyState(TypedDict):
    key_hash: str
    inherited: bool
    policy: AgentPolicy
    sha256: str
    version: int
    killed: bool
    killed_at: str | None
    killed_reason: str | None
    spent: dict[str, float]
    remaining: AgentRemaining


class AgentRulebook(TypedDict):
    key_hash: str
    name: str | None
    policy: AgentPolicy | None
    sha256: str | None
    killed: bool
    remaining: AgentRemaining
    policies: list[AgentPolicyState]


class AgentClient:
    def __init__(self, base_url: str, http: httpx.Client, headers: Callable[[], dict[str, str]]):
        self._base_url, self._http, self._headers = base_url, http, headers

    def _request(self, path: str, intent: AgentIntent | None = None) -> Any:
        kwargs = {"json": intent} if intent is not None else {}
        res = self._http.request("POST" if intent is not None else "GET", f"{self._base_url}/api/v1/agents/{path}", headers={"accept": "application/json", "content-type": "application/json", **self._headers()}, **kwargs)
        try:
            data = res.json()
        except ValueError:
            data = None
        if not res.is_success or not isinstance(data, dict):
            err = data.get("error", {}) if isinstance(data, dict) else {}
            raise request_error(err.get("message") or f"agent request failed with {res.status_code}", err.get("type") or "request_failed", res.status_code, err.get("metadata"))
        return data["data"]

    def rules(self) -> AgentRulebook:
        """Read own and inherited rules even when killed."""
        return self._request("me")

    def check(self, intent: AgentIntent) -> AgentDecision:
        """Check before expensive calls. Never retry a denial unchanged. Reserves no budget."""
        return self._request("check", intent)
