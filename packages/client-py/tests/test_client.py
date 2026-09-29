from __future__ import annotations

import json

import httpx
import pytest

from anyroute_client import AnyRoute, AttestationRefused, ReceiptInvalid
from anyroute_client.client import AttestedOptions, routing_headers, with_routing

from .conftest import NOW_MS, Real, RouterKey

BODY = {"model": "example/model", "messages": [{"role": "user", "content": "hi"}]}


class FakeRouter:
    def __init__(self, provider: str = "example-provider", tamper: bool = False) -> None:
        self.key = RouterKey()
        self.provider = provider
        self.tamper = tamper
        self.chat: list[dict] = []
        self.calls: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req.url.path)
        p = req.url.path
        if p == "/.well-known/anyroute-receipt-keys.json":
            return httpx.Response(200, json={"keys": [self.key.jwk]})
        if p == "/api/v1/chat/completions":
            body = json.loads(req.content)
            self.chat.append({"headers": dict(req.headers), "body": body})
            payload = {"v": 1, "id": "gen-1", "issued": "2026-09-29T08:29:00.000Z", "model": body["model"], "provider": self.provider, "disclosure": "attested"}
            receipt = self.key.sign(payload)
            if self.tamper:
                receipt["payload"] = {**payload, "cost": "0.5"}
            return httpx.Response(200, json={"id": "gen-1", "choices": [{"message": {"content": "hello"}}], "receipt": receipt}, headers={"x-generation-id": "gen-1", "x-anyroute-disclosure": "attested", "x-anyroute-lane": "attested"})
        if p == "/api/v1/attestation/example-provider":
            return httpx.Response(200, json={"data": Real.router()})
        if p == "/attest":
            return httpx.Response(200, json=Real.fresh()["response"] if req.url.params.get("nonce") else Real.boot())
        return httpx.Response(404, json={"error": {"message": "no stub"}})


def client(router: FakeRouter, **kw) -> AnyRoute:
    return AnyRoute("https://router.test/", "sk-test", http=httpx.Client(transport=httpx.MockTransport(router)), now_ms=lambda: NOW_MS, **kw)


ATTESTED = dict(provider_id="example-provider", attest_url="https://provider.test/attest", fresh_nonce=False, certificate=Real.cert_pem())


def test_sends_an_openai_shaped_request_and_verifies_the_receipt():
    r = FakeRouter()
    res = client(r).chat(BODY)
    assert res["choices"][0]["message"]["content"] == "hello"
    assert res["anyroute"]["receipt_verification"].valid
    assert res["anyroute"]["disclosure"] == "attested"
    assert r.chat[0]["headers"]["authorization"] == "Bearer sk-test"
    assert r.chat[0]["body"] == BODY  # nothing added when no options were set


def test_a_receipt_that_does_not_verify_is_reported_and_raised_when_strict():
    r = FakeRouter(tamper=True)
    assert not client(r).chat(BODY)["anyroute"]["receipt_verification"].valid
    with pytest.raises(ReceiptInvalid):
        client(r, strict_receipts=True).chat(BODY)


def test_disclosure_and_lane_never_loosen_what_the_caller_set():
    r = FakeRouter()
    client(r, disclosure="policy").chat({**BODY, "provider": {"sort": "price", "disclosure": "none"}}, lane="attested")
    sent = r.chat[0]
    assert sent["body"]["provider"] == {"sort": "price", "disclosure": "none", "lane": "attested"}
    assert sent["headers"]["x-anyroute-disclosure-max"] == "policy" and sent["headers"]["x-anyroute-lane"] == "attested"
    assert with_routing(BODY, lane="unlinkable")["provider"] == {"lane": "unlinkable"}  # passed through for the router to refuse
    assert routing_headers() == {}
    assert with_routing(BODY) is BODY


def test_blind_token_authorization():
    r = FakeRouter()
    client(r).with_private_token("TOKEN123").chat(BODY)
    assert r.chat[0]["headers"]["authorization"] == "PrivateToken token=TOKEN123"


def test_a_verified_provider_is_used_exclusively_and_the_receipt_is_checked_against_it():
    r = FakeRouter()
    res = client(r).chat(BODY, attested=AttestedOptions(**ATTESTED))
    assert r.chat[0]["body"]["provider"] == {"disclosure": "none", "lane": "attested", "only": ["example-provider"], "allow_fallbacks": False}
    assert res["anyroute"]["provider"].ok and res["anyroute"]["served_by_verified_provider"] is True
    assert r.calls.index("/api/v1/chat/completions") > len(r.calls) - 1 - r.calls[::-1].index("/attest")


def test_a_receipt_naming_another_provider_is_flagged():
    res = client(FakeRouter(provider="someone-else")).chat(BODY, attested=AttestedOptions(**ATTESTED))
    assert res["anyroute"]["served_by_verified_provider"] is False


def test_refuses_before_sending_anything_when_the_evidence_does_not_verify():
    from anyroute_client import ExpectedDigests

    r = FakeRouter()
    with pytest.raises(AttestationRefused) as e:
        client(r).chat(BODY, attested=AttestedOptions(**ATTESTED, expected=ExpectedDigests(model_digest="sha256:" + "00" * 32)))
    assert e.value.verification.status("expected.model") == "fail"
    assert r.chat == []
    stale = AnyRoute("https://router.test", "k", http=httpx.Client(transport=httpx.MockTransport(r)), now_ms=lambda: NOW_MS + 3 * 3_600_000)
    with pytest.raises(AttestationRefused, match="older than"):
        stale.chat(BODY, attested=AttestedOptions(**ATTESTED))
    assert r.chat == []


def test_refuses_when_the_provider_is_unreachable():
    r = FakeRouter()

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": Real.router()}) if req.url.path.startswith("/api/") else httpx.Response(503)

    c = AnyRoute("https://router.test", "k", http=httpx.Client(transport=httpx.MockTransport(handler)), now_ms=lambda: NOW_MS)
    with pytest.raises(AttestationRefused):
        c.chat(BODY, attested=AttestedOptions(**ATTESTED))
    assert r.chat == []


def test_a_passing_verification_is_reused_until_the_cache_expires():
    r = FakeRouter()
    c = client(r)
    c.chat(BODY, attested=AttestedOptions(**ATTESTED))
    reads = lambda: r.calls.count("/api/v1/attestation/example-provider")  # noqa: E731
    before = reads()
    c.chat(BODY, attested=AttestedOptions(**ATTESTED))
    assert reads() == before
    c.chat(BODY, attested=AttestedOptions(**ATTESTED, cache_seconds=0))
    assert reads() == before + 1


def test_router_errors_carry_status_type_and_metadata():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": {"message": "No provider meets the disclosure ceiling.", "type": "disclosure_unavailable", "metadata": {"requested": {"disclosure": "none"}}}})

    c = AnyRoute("https://router.test", "k", http=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(Exception) as e:
        c.chat(BODY)
    assert (e.value.status, e.value.code, e.value.details) == (409, "disclosure_unavailable", {"requested": {"disclosure": "none"}})
