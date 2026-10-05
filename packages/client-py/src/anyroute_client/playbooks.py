"""Playbooks: one named rulebook that many keys of an account or team follow. A change applies to every following key
from its next request. For a management key or a team owner/admin key; same switch as rulebooks (AGENT_POLICY_ENABLED),
and disabled routes return 404."""
from typing import Any, Callable, Literal, Optional, TypedDict
from urllib.parse import quote
import httpx
from .agent import AgentPolicy
from .agent_errors import request_error


class PlaybookKey(TypedDict):
    key_hash: str
    name: Optional[str]


class Playbook(TypedDict):
    id: str
    name: str
    team_id: Optional[str]
    policy: AgentPolicy
    sha256: str
    version: int  # 1 at creation, plus one for each change of rules
    created_at: str
    updated_at: str
    updated_by: str
    followers: int  # every key that follows the playbook
    keys: list[PlaybookKey]  # the following keys the calling key manages
    can_edit: bool


class PlaybookChange(TypedDict):
    action: Literal["create", "update", "rename", "delete"]
    version: int
    sha256: str
    name: str
    followers: int
    at: str


class PlaybookClient:
    def __init__(self, base_url: str, http: httpx.Client, headers: Callable[[], dict[str, str]]):
        self._base_url, self._http, self._headers = base_url, http, headers

    def _request(self, path: str, method: str = "GET", body: Any = None) -> Any:
        kwargs = {"json": body} if body is not None else {}
        res = self._http.request(method, f"{self._base_url}/api/v1{path}", headers={"accept": "application/json", "content-type": "application/json", **self._headers()}, **kwargs)
        try:
            data = res.json()
        except ValueError:
            data = None
        if not res.is_success or not isinstance(data, dict):
            err = data.get("error", {}) if isinstance(data, dict) else {}
            raise request_error(err.get("message") or f"playbook request failed with {res.status_code}", err.get("type") or "request_failed", res.status_code, err.get("metadata"))
        return data["data"]

    @staticmethod
    def _one(playbook_id: str) -> str:
        return "/playbooks/" + quote(playbook_id, safe="")

    def list(self) -> list[Playbook]:
        return self._request("/playbooks")

    def get(self, playbook_id: str) -> dict:
        """The playbook with its latest recorded changes (``changes``), newest first."""
        return self._request(self._one(playbook_id))

    def create(self, name: str, policy: AgentPolicy, team_id: Optional[str] = None) -> Playbook:
        body: dict[str, Any] = {"name": name, "policy": policy}
        if team_id is not None:
            body["team_id"] = team_id
        return self._request("/playbooks", "POST", body)

    def update(self, playbook_id: str, name: Optional[str] = None, policy: Optional[AgentPolicy] = None) -> dict:
        """New rules raise the version and reach every following key; ``changed`` is False when nothing differs."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if policy is not None:
            body["policy"] = policy
        return self._request(self._one(playbook_id), "PUT", body)

    def delete(self, playbook_id: str, unlink: Optional[Literal["copy"]] = None) -> dict:
        """Refused (playbook_followed) while keys follow it, unless ``unlink="copy"``: each key then keeps the rules."""
        return self._request(self._one(playbook_id) + ("?unlink=copy" if unlink == "copy" else ""), "DELETE")

    def follow(self, key_hash: str, playbook_id: Optional[str]) -> dict:
        """Make a key follow a playbook, or stop following with None (the key keeps the playbook's rules as its own)."""
        return self._request(f"/agents/{quote(key_hash, safe='')}/playbook", "POST", {"playbook_id": playbook_id})
