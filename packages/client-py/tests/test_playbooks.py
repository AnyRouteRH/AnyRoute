import json
import httpx
import pytest
from anyroute_client import AnyRoute, AnyRouteError

POLICY = {"version": 1, "models": {"allow": ["author/*"]}, "caps": {"per_day_usd": 2}, "on_breach": "deny"}
BOOK = {"id": "pb_1", "name": "Support bots", "team_id": None, "policy": POLICY, "sha256": "digest", "version": 2, "followers": 1, "keys": [{"key_hash": "k1", "name": "bot"}], "can_edit": True}


def test_playbook_methods_call_the_playbook_routes_and_return_data_unchanged():
    seen = []

    def handler(req):
        assert req.headers["authorization"] == "Bearer key"
        body = json.loads(req.content) if req.content else None
        seen.append((req.method, req.url.path + (("?" + req.url.query.decode()) if req.url.query else ""), body))
        if req.url.path.endswith("/playbook"):
            return httpx.Response(200, json={"data": {"key_hash": "k1", "changed": True, "playbook_id": body["playbook_id"]}})
        if req.method == "DELETE":
            return httpx.Response(200, json={"data": {"id": "pb_1", "deleted": True, "unlinked": 1}})
        if req.method == "GET" and req.url.path.endswith("/playbooks"):
            return httpx.Response(200, json={"data": [BOOK]})
        return httpx.Response(200, json={"data": BOOK})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        c = AnyRoute("https://router.test", "key", http=http)
        assert c.playbooks.list() == [BOOK]
        assert c.playbooks.create("Support bots", POLICY, team_id="team_1") == BOOK
        assert c.playbooks.get("pb_1") == BOOK
        assert c.playbooks.update("pb_1", policy=POLICY) == BOOK
        assert c.playbooks.delete("pb_1", unlink="copy")["unlinked"] == 1
        assert c.playbooks.follow("k1", "pb_1")["playbook_id"] == "pb_1"
        assert c.playbooks.follow("k1", None)["playbook_id"] is None
    assert seen == [
        ("GET", "/api/v1/playbooks", None),
        ("POST", "/api/v1/playbooks", {"name": "Support bots", "policy": POLICY, "team_id": "team_1"}),
        ("GET", "/api/v1/playbooks/pb_1", None),
        ("PUT", "/api/v1/playbooks/pb_1", {"policy": POLICY}),
        ("DELETE", "/api/v1/playbooks/pb_1?unlink=copy", None),
        ("POST", "/api/v1/agents/k1/playbook", {"playbook_id": "pb_1"}),
        ("POST", "/api/v1/agents/k1/playbook", {"playbook_id": None}),
    ]


def test_a_refused_playbook_change_keeps_the_router_code_and_metadata():
    def handler(req):
        return httpx.Response(409, json={"error": {"type": "playbook_followed", "message": "2 keys follow this playbook.", "metadata": {"followers": 2}}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(AnyRouteError) as e:
            AnyRoute("https://router.test", "key", http=http).playbooks.delete("pb_1")
    assert e.value.status == 409
    assert e.value.code == "playbook_followed"
