"""Read and check the calling key's rulebook, and replay a draft one. Dry runs and replays reserve no budget."""
from typing import Any, Callable, Literal, TypedDict, Union
from urllib.parse import quote
import httpx
from .agent_errors import request_error

AgentLane = Literal["public", "attested", "unlinkable"]
# The lane for a request that names none: "standard" (the default), "proven_first" (attested when available) or
# "proven_only" (attested, or refused).
AgentRouteDefault = Literal["standard", "proven_first", "proven_only"]


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
    route_default: AgentRouteDefault
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


AgentOutcome = Literal["allow", "deny", "approval_required"]


class AgentReplayReason(TypedDict):
    code: str
    message: str


class AgentReplayExample(TypedDict):
    """One replayed call or Guard action. ``actual`` is the decision recorded at the time; None when none was recorded."""
    time: str
    kind: Literal["call", "action"]
    model: str | None
    lane: str | None
    action: str | None
    cost_usd: float
    decision: AgentOutcome
    reason: AgentReplayReason | None
    actual: AgentOutcome | None


# "from" is a Python keyword, so this one uses the functional form.
AgentReplayWindow = TypedDict("AgentReplayWindow", {"from": str, "to": str, "days": int})


class AgentReplayActual(TypedDict):
    allowed: int
    denied: int
    asked: int
    not_recorded: int


class _AgentReplayOptional(TypedDict, total=False):
    stopped_at: str
    stopped_reason: str


class AgentReplay(_AgentReplayOptional):
    """What a draft rulebook would have done with a key's recorded activity. ``notes`` says what the record cannot tell."""
    window: AgentReplayWindow
    evaluated: int
    allowed: int
    denied: int
    asked: int
    by_reason: dict[str, int]
    actual: AgentReplayActual
    changed: int
    examples: list[AgentReplayExample]
    truncated: bool
    notes: list[str]

class _AgentPayOptional(TypedDict, total=False):
    memo_sha256: str
    approval_id: str


class AgentPayInput(_AgentPayOptional):
    """Pay another agent: a public profile id or 0x wallet and a decimal USD amount (USDG, up to 6 decimals)."""
    to: str
    amount_usd: str


class AgentPayDecision(TypedDict, total=False):
    """Agent Guard's answer for action pay.agent; `payment` holds the instructions on allow."""
    decision: Literal["allow", "deny", "approval_required"]
    reasons: list[dict[str, str]]
    decision_id: str
    policy_sha256: str
    approval_id: str
    expires_at: str
    poll: str
    signed: dict[str, Any]
    payment: dict[str, Any]


class AgentPayment(TypedDict, total=False):
    """A confirmed payment; `receipt` verifies at POST /api/v1/receipts/verify with payload, sig and key_id."""
    decision_id: str
    status: Literal["awaiting_transfer", "seen", "final", "reversed"]
    status_text: str
    status_at: str
    recipient: dict[str, Any]
    amount: str
    amount_units: str
    paid: str | None
    tx_hash: str | None
    block_number: str | None
    payer_wallet: str | None
    verified_at: str | None
    reason: str
    receipt: dict[str, Any] | None


class AgentClient:
    def __init__(self, base_url: str, http: httpx.Client, headers: Callable[[], dict[str, str]]):
        self._base_url, self._http, self._headers = base_url, http, headers

    def _request(self, path: str, body: Any = None) -> Any:
        kwargs = {"json": body} if body is not None else {}
        res = self._http.request("POST" if body is not None else "GET", f"{self._base_url}/api/v1/agents/{path}", headers={"accept": "application/json", "content-type": "application/json", **self._headers()}, **kwargs)
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

    def replay(self, key_hash: str, policy: AgentPolicy, days: int | None = None) -> AgentReplay:
        """Replay a draft rulebook on a key's last ``days`` (1 to 7, default 7) of recorded calls and Agent Guard checks,
        before saving it. Read only: nothing is saved, charged or changed. Needs the same permissions as setting that
        key's rulebook."""
        body: dict[str, Any] = {"policy": policy}
        if days is not None:
            body["days"] = days
        return self._request(f"{quote(key_hash, safe='')}/replay", body)

    def pay(self, to: str, amount_usd: str, memo_sha256: str | None = None, approval_id: str | None = None) -> AgentPayDecision:
        """Ask the rulebook before paying another agent (Agent Guard action pay.agent). Anyroute never holds the money:
        on allow, send payment["transfer_call"] from your own wallet straight to the recipient."""
        body: AgentPayInput = {"to": to, "amount_usd": amount_usd}
        if memo_sha256 is not None:
            body["memo_sha256"] = memo_sha256
        if approval_id is not None:
            body["approval_id"] = approval_id
        return self._request("pay", body)

    def confirm_pay(self, decision_id: str, tx_hash: str) -> AgentPayment:
        """Confirm with the transaction hash; returns the payment and its signed receipt. Call again to read seen, final or reversed."""
        return self._request(f"pay/{quote(decision_id, safe='')}/confirm", {"tx_hash": tx_hash})
