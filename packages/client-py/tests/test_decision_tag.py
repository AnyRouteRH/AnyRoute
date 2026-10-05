from __future__ import annotations

import json

import httpx

from anyroute_client import DECISION_TAG_HEADER, AnyRoute, check_decision_tag, decision_tag, receipt_decision_tag, with_decision_tag

from .conftest import NOW_MS, RouterKey

# The known vector shared with the router's tests, integrations/robinhood-agents and the TypeScript SDK.
ORDER = {"symbol": "STOCK_A", "side": "buy", "quantity": "2", "limit_price": "180.00", "client_order_id": "7f3c"}
TAG = "sha256:c6a5490500b12be3787fadaa8d87982c369b158af7f5cdfdc8643b5177477c8d"


def test_decision_tag_hashes_the_canonical_json_whatever_the_key_order():
    assert decision_tag(ORDER) == TAG
    assert decision_tag(dict(reversed(list(ORDER.items())))) == TAG
    assert decision_tag({**ORDER, "quantity": 2}) != TAG


def test_with_decision_tag_adds_the_header_and_keeps_the_callers_own():
    assert DECISION_TAG_HEADER == "X-Anyroute-Decision-Tag"
    assert with_decision_tag(ORDER) == {"X-Anyroute-Decision-Tag": TAG}
    assert with_decision_tag(ORDER, {"x-title": "agent"}) == {"x-title": "agent", "X-Anyroute-Decision-Tag": TAG}


def test_the_client_sends_the_tag_and_the_signed_receipt_checks_against_the_order():
    key = RouterKey()
    sent: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/.well-known/anyroute-receipt-keys.json":
            return httpx.Response(200, json={"keys": [key.jwk]})
        sent.append(dict(req.headers))
        tag = req.headers.get(DECISION_TAG_HEADER)
        payload = {"v": 1, "id": "gen-1", "issued": "2026-09-29T08:29:00.000Z", "model": json.loads(req.content)["model"], "provider": "p", **({"decision_tag": tag} if tag else {})}
        return httpx.Response(200, json={"id": "gen-1", "choices": [{"message": {"content": "wait"}}], "receipt": key.sign(payload)})

    c = AnyRoute("https://router.test", "k", http=httpx.Client(transport=httpx.MockTransport(handler)), now_ms=lambda: NOW_MS)
    res = c.chat({"model": "example/model", "messages": [{"role": "user", "content": "buy or wait?"}]}, headers=with_decision_tag(ORDER))
    assert sent[0][DECISION_TAG_HEADER.lower()] == TAG
    assert res["anyroute"]["receipt_verification"].valid
    assert receipt_decision_tag(res["receipt"]) == TAG
    assert check_decision_tag(res["receipt"], ORDER) == {"matches": True, "tag": TAG, "expected": TAG}
    assert not check_decision_tag(res["receipt"], {**ORDER, "quantity": "20"})["matches"]
    # v2 claims count when there is no v1 payload; a receipt with no tag never matches.
    assert receipt_decision_tag({"v2": {"claims": {"decision_tag": TAG}}}) == TAG
    assert check_decision_tag({"payload": {"model": "m"}}, ORDER) == {"matches": False, "tag": None, "expected": TAG}
    assert receipt_decision_tag(None) is None
