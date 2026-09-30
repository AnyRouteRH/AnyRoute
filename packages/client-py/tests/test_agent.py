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
