import json
import httpx
import pytest
from anyroute_client import AnyRoute, AnyRouteError, AgentPolicyDenied, AgentKilled, AgentApprovalRequired

INTENT = {"kind": "inference", "model": "example/model", "lane": "public", "est_cost_pico": "1000000000", "max_output_tokens": 32, "tools": []}


def test_rules_and_check_authenticate_and_return_data_unchanged():
    rules = {"policy": None, "killed": True, "remaining": {"hour": None, "day": None, "week": None}, "policies": []}
    decision = {"decision": "deny", "reasons": [{"code": "killed", "message": "Agent is killed."}]}
    calls = []

    def handler(req):
        calls.append(req)
        assert req.headers["authorization"] == "Bearer key"
        assert req.headers["x-extra"] == "value"
        if req.url.path.endswith("/me"):
            assert req.method == "GET"
            return httpx.Response(200, json={"data": rules})
        assert req.method == "POST"
        assert json.loads(req.content) == INTENT
        return httpx.Response(200, json={"data": decision})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        c = AnyRoute("https://router.test", "key", http=http, headers={"x-extra": "value"})
        assert c.agent.rules() == rules
        assert c.agent.check(INTENT) == decision
    assert len(calls) == 2


@pytest.mark.parametrize("code,kind", [("agent_policy_denied", AgentPolicyDenied), ("agent_killed", AgentKilled), ("agent_approval_required", AgentApprovalRequired)])
@pytest.mark.parametrize("method", ["chat", "rules", "check"])
def test_typed_refusals_preserve_metadata_without_retry(code, kind, method):
    metadata = {"reasons": [{"code": "approval_required", "message": "Owner approval required."}], "policy_sha256": "digest", "approval_id": "approval-1", "poll": {"url": "/api/v1/approvals/approval-1", "after_ms": 1000}}
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(403, json={"error": {"type": code, "message": "Router reason verbatim.", "metadata": metadata}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        c = AnyRoute("https://router.test", "key", http=http)
        with pytest.raises(kind) as caught:
            if method == "chat":
                c.chat({"model": "example/model", "messages": [{"role": "user", "content": "hi"}]})
            elif method == "rules":
                c.agent.rules()
            else:
                c.agent.check(INTENT)
    e = caught.value
    assert isinstance(e, AnyRouteError)
    assert str(e) == "Router reason verbatim."
    assert e.status == 403 and e.code == code and e.details == metadata
    assert e.reasons == metadata["reasons"] and e.policy_sha256 == "digest"
    if isinstance(e, AgentApprovalRequired):
        assert e.approval_id == "approval-1" and e.poll == metadata["poll"]
    assert len(calls) == 1


def test_absent_approval_metadata_and_disabled_routes():
    e = AgentApprovalRequired("Approval required.")
    assert e.approval_id is None and e.poll is None
    with httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(404, json={"error": {"type": "not_found", "message": "Not found."}}))) as http:
        with pytest.raises(AnyRouteError) as caught:
            AnyRoute("https://router.test", http=http).agent.rules()
        assert type(caught.value) is AnyRouteError and caught.value.status == 404


def test_replay_posts_the_draft_to_the_key_and_returns_data_unchanged():
    policy = {"version": 1, "models": {"deny": ["beta/*"]}, "caps": {"per_day_usd": 5}, "on_breach": "deny"}
    result = {"window": {"from": "2026-09-21T00:00:00.000Z", "to": "2026-09-28T00:00:00.000Z", "days": 7}, "evaluated": 2, "allowed": 1, "denied": 1, "asked": 0,
              "by_reason": {"model_not_allowed": 1}, "actual": {"allowed": 2, "denied": 0, "asked": 0, "not_recorded": 0}, "changed": 1, "examples": [], "truncated": False, "notes": []}
    bodies = []

    def handler(req):
        assert req.method == "POST"
        assert req.url.raw_path == b"/api/v1/agents/hash%2Fone/replay"
        assert req.headers["authorization"] == "Bearer key"
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json={"data": result})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        c = AnyRoute("https://router.test", "key", http=http)
        assert c.agent.replay("hash/one", policy) == result
        assert c.agent.replay("hash/one", policy, days=2) == result
    assert bodies == [{"policy": policy}, {"policy": policy, "days": 2}]


def test_replay_refusals_surface_as_errors():
    def handler(req):
        return httpx.Response(429, json={"error": {"type": "rate_limited", "message": "Too many replays from this key. Try again within a minute."}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        c = AnyRoute("https://router.test", "key", http=http)
        with pytest.raises(AnyRouteError) as e:
            c.agent.replay("hash", {"version": 1, "models": {}, "caps": {}, "on_breach": "deny"})
    assert e.value.status == 429

def test_pay_and_confirm_pay_send_the_agent_key_and_return_data_unchanged():
    decision = {"decision": "allow", "reasons": [], "decision_id": "decision-1", "policy_sha256": "digest", "payment": {"status": "awaiting_transfer", "amount_units": "20000000"}}
    payment = {"decision_id": "decision-1", "status": "seen", "status_text": "Seen, waiting for finality", "receipt": {"payload": {"type": "anyroute.agent.payment.v1"}, "sig": "sig", "key_id": "kid"}}
    tx = "0x" + "1" * 64
    calls = []

    def handler(req):
        calls.append(req)
        assert req.headers["authorization"] == "Bearer key"
        assert req.method == "POST"
        if req.url.raw_path.decode().endswith("/confirm"):
            assert req.url.raw_path.decode() == "/api/v1/agents/pay/decision%2F1/confirm"
            assert json.loads(req.content) == {"tx_hash": tx}
            return httpx.Response(200, json={"data": payment})
        assert req.url.path == "/api/v1/agents/pay"
        assert json.loads(req.content) == {"to": "profile-id", "amount_usd": "20", "approval_id": "approval-1"}
        return httpx.Response(200, json={"data": decision})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        c = AnyRoute("https://router.test", "key", http=http)
        assert c.agent.pay("profile-id", "20", approval_id="approval-1") == decision
        assert c.agent.confirm_pay("decision/1", tx) == payment
    assert len(calls) == 2


def test_confirm_pay_surfaces_the_router_reason():
    def handler(req):
        return httpx.Response(403, json={"error": {"type": "pay_wallet_not_linked", "message": "Not linked."}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        c = AnyRoute("https://router.test", "key", http=http)
        with pytest.raises(AnyRouteError) as caught:
            c.agent.confirm_pay("decision-1", "0x" + "1" * 64)
    assert caught.value.status == 403 and caught.value.code == "pay_wallet_not_linked" and str(caught.value) == "Not linked."
