from __future__ import annotations

import json

import httpx
import pytest

from anyroute import LANES, Anyroute, merge_provider, stricter_disclosure, stricter_lane

from .conftest import API_KEY, BASE, FakeRouter

MSG = [{"role": "user", "content": "hi"}]


def sent(router: FakeRouter) -> tuple[httpx.Headers, dict]:
    return router.last.headers, json.loads(router.last.content)


def test_constants_and_ranking() -> None:
    assert LANES == ("public", "attested", "unlinkable")
    assert stricter_lane("public", None, "attested") == "attested"
    assert stricter_lane(None) is None
    assert stricter_disclosure("any", "none", "policy") == "none"


def test_merge_never_loosens() -> None:
    assert merge_provider({"model": "m"}, "attested")["provider"] == {"lane": "attested"}
    assert merge_provider({"provider": {"lane": "unlinkable"}}, "attested")["provider"]["lane"] == "unlinkable"
    assert merge_provider({"provider": {"lane": "public", "only": ["x"]}}, "attested")["provider"] == {"lane": "attested", "only": ["x"]}
    assert merge_provider({"provider": {"disclosure": "none"}}, None, "any")["provider"] == {"disclosure": "none"}
    body = {"provider": {"lane": "public"}}
    merge_provider(body, "unlinkable")
    assert body == {"provider": {"lane": "public"}}  # the input is not mutated


def test_per_call_lane_sets_header_and_body(client: Anyroute, router: FakeRouter) -> None:
    reply = client.chat.completions.create(model="example/private-chat", messages=MSG, lane="attested", disclosure="policy")
    headers, body = sent(router)
    assert headers["x-anyroute-lane"] == "attested"
    assert headers["x-anyroute-disclosure-max"] == "policy"
    assert body["provider"] == {"lane": "attested", "disclosure": "policy"}
    assert reply.anyroute.lane == "attested"


def test_stricter_body_value_wins_and_header_follows(client: Anyroute, router: FakeRouter) -> None:
    client.chat.completions.create(model="example/private-chat", messages=MSG, provider={"lane": "unlinkable", "disclosure": "none", "order": ["a"]}, lane="attested", disclosure="any")
    headers, body = sent(router)
    assert body["provider"] == {"lane": "unlinkable", "disclosure": "none", "order": ["a"]}
    assert headers["x-anyroute-lane"] == "unlinkable"
    assert headers["x-anyroute-disclosure-max"] == "none"


def test_client_lane_applies_everywhere_and_calls_only_tighten(router: FakeRouter) -> None:
    c = Anyroute(API_KEY, base_url=BASE, lane="attested", http_client=httpx.Client(transport=httpx.MockTransport(router)))
    c.chat.completions.create(model="example/private-chat", messages=MSG, lane="public")
    headers, body = sent(router)
    assert headers["x-anyroute-lane"] == "attested" and body["provider"]["lane"] == "attested"
    c.embeddings.create(model="example/embed", input="x", lane="unlinkable")
    headers, body = sent(router)
    assert headers["x-anyroute-lane"] == "unlinkable" and body["provider"]["lane"] == "unlinkable"
    c.models.list()
    assert router.last.headers["x-anyroute-lane"] == "attested"


def test_with_lane_returns_a_copy(client: Anyroute, router: FakeRouter) -> None:
    private = client.with_lane("unlinkable", disclosure="none")
    assert private is not client and client.lane is None
    assert private.lane == "unlinkable" and private.disclosure == "none"
    private.rerank.create(model="example/reranker", query="q", documents=["a", "b"])
    headers, body = sent(router)
    assert headers["x-anyroute-lane"] == "unlinkable" and headers["x-anyroute-disclosure-max"] == "none"
    assert body["provider"] == {"lane": "unlinkable", "disclosure": "none"}
    client.chat.completions.create(model="example/chat", messages=MSG)
    assert "x-anyroute-lane" not in router.last.headers  # the original is unchanged
    assert private._keys is client._keys  # the copy shares the key cache


def test_batch_lane_merges_into_every_body(client: Anyroute, router: FakeRouter) -> None:
    client.batches.create([{"custom_id": "a", "body": {"model": "m", "messages": MSG}}, {"custom_id": "b", "body": {"model": "m", "messages": MSG, "provider": {"lane": "unlinkable"}}}], lane="attested")
    headers, body = sent(router)
    assert headers["x-anyroute-lane"] == "attested"
    assert [r["body"]["provider"]["lane"] for r in body["requests"]] == ["attested", "unlinkable"]


def test_unknown_lane_is_rejected(client: Anyroute) -> None:
    with pytest.raises(ValueError):
        client.chat.completions.create(model="m", messages=MSG, lane="secret")
    with pytest.raises(ValueError):
        client.with_lane("private")
    with pytest.raises(ValueError):
        client.models.list(lane="nope")
