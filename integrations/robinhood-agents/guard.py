"""Check before the developer's order function; no added dependencies.
Rules apply to actions your agent checks first. Wired into your code before the order function, the model can't skip
the check; it doesn't stop whoever holds the brokerage or wallet keys. Amounts traded count what your agent reports.
A reporting error after execution must not cause the order function to be retried.
"""
from __future__ import annotations
import json
import time
import urllib.request
from decision_receipt import order_intent_hash


class GuardDenied(Exception):
    def __init__(self, reasons):
        self.reasons = reasons
        super().__init__(f"Action denied: {reasons}")


def guarded(opts, action, describe, fn):
    """opts: api_key, amount_usd, executed_amount_usd(result), optional target/base_url/timeout_s/request."""
    deadline = time.monotonic() + opts.get("timeout_s", 900)

    def request(path, body=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Guard approval deadline reached")
        if opts.get("request"):
            return opts["request"](path, body)
        req = urllib.request.Request(opts.get("base_url", "https://anyroute.tech").rstrip("/") + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + opts["api_key"], "Content-Type": "application/json"},
            method="GET" if body is None else "POST")
        with urllib.request.urlopen(req, timeout=min(30, remaining)) as response:
            return json.load(response)["data"]

    body = {"action": action, "amount_usd": opts["amount_usd"], "details_sha256": order_intent_hash(describe)}
    if "target" in opts:
        body["target"] = opts["target"]
    decision = request("/api/v1/guard/decide", body)
    if decision["decision"] == "approval_required":
        approval_id = decision["approval_id"]
        while True:
            approval = request("/api/v1/agents/approvals/" + approval_id)
            if approval["status"] == "approved":
                break
            if approval["status"] != "pending":
                raise GuardDenied([{"code": "approval_" + approval["status"]}])
            time.sleep(min(2, max(0, deadline - time.monotonic())))
        decision = request("/api/v1/guard/decide", dict(body, approval_id=approval_id))
    if decision["decision"] != "allow":
        raise GuardDenied(decision["reasons"])
    path = "/api/v1/guard/decisions/" + decision["decision_id"] + "/outcome"
    try:
        result = fn()
    except Exception as error:
        try:
            request(path, {"status": "failed"})
        except Exception as report_error:
            raise RuntimeError(f"Action failed and its outcome could not be reported: {report_error}") from error
        raise
    try:
        request(path, {"status": "executed", "amount_usd": opts["executed_amount_usd"](result)})
    except Exception as error:
        raise RuntimeError(f"Action completed; report for decision {decision['decision_id']} needs reconciliation. Do not retry the action.") from error
    return result
