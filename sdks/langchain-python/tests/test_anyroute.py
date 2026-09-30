# SPDX-License-Identifier: Apache-2.0
"""Offline tests: an httpx MockTransport plays the router, so nothing leaves the machine."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from langchain_anyroute import ANYROUTE_BASE_URL, AnyrouteEmbeddings, ChatAnyroute, receipt_of

RECEIPT = {
    "id": "gen-test-1",
    "sig": "c2lnbmF0dXJl",
    "key_id": "21fe31dfa154a261",
    "alg": "Ed25519",
    "payload": {"rid": "gen-test-1", "model": "meta-llama/llama-3.3-70b-instruct"},
    "leaf": "0xabc",
}

HEADERS = {
    "content-type": "application/json",
    "x-generation-id": "gen-test-1",
    "x-receipt-id": "gen-test-1",
    "x-anyroute-lane": "attested",
    "x-anyroute-disclosure": "attested",
}


def completion(receipt: dict | None = RECEIPT) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": "gen-test-1",
        "object": "chat.completion",
        "created": 1_700_000_000,
        "model": "meta-llama/llama-3.3-70b-instruct",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": "Hello there, friend of mine."}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 6, "total_tokens": 11},
    }
    if receipt is not None:
        body["receipt"] = receipt
    return body


class Router:
    """Records requests and answers each with `respond(request)`."""

    def __init__(self, respond):
        self.respond = respond
        self.seen: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        return self.respond(request)

    def body(self, i: int = 0) -> dict[str, Any]:
        return json.loads(self.seen[i].content)


def json_router(body: dict[str, Any], headers: dict[str, str] = HEADERS) -> Router:
    return Router(lambda _req: httpx.Response(200, json=body, headers=headers))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("ANYROUTE_API_KEY", "ANYROUTE_BASE_URL", "OPENAI_API_KEY", "OPENAI_API_BASE", "OPENAI_BASE_URL"):
        monkeypatch.delenv(name, raising=False)


def make_chat(router: Router, **kwargs: Any) -> ChatAnyroute:
    kwargs.setdefault("api_key", "sk-ar-v1-test")
    return ChatAnyroute(
        model="meta-llama/llama-3.3-70b-instruct",
        http_client=httpx.Client(transport=httpx.MockTransport(router)),
        http_async_client=httpx.AsyncClient(transport=httpx.MockTransport(router)),
        max_retries=0,
        **kwargs,
    )


def test_invoke_sends_lane_and_surfaces_receipt():
    router = json_router(completion())
    msg = make_chat(router, lane="attested", disclosure="policy").invoke("Say hello in five words.")

    assert msg.content == "Hello there, friend of mine."
    assert msg.response_metadata["anyroute"] == {
        "receipt_id": "gen-test-1",
        "lane": "attested",
        "disclosure": "attested",
        "receipt": RECEIPT,
    }
    assert receipt_of(msg)["receipt_id"] == "gen-test-1"
    assert "headers" not in msg.response_metadata

    req = router.seen[0]
    assert str(req.url) == f"{ANYROUTE_BASE_URL}/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-ar-v1-test"
    assert req.headers["x-anyroute-lane"] == "attested"
    assert req.headers["x-anyroute-disclosure-max"] == "policy"
    assert router.body()["provider"] == {"lane": "attested", "disclosure": "policy"}


def test_key_and_base_url_from_env(monkeypatch):
    monkeypatch.setenv("ANYROUTE_API_KEY", "sk-ar-v1-env")
    monkeypatch.setenv("ANYROUTE_BASE_URL", "http://localhost:8787/api/v1/")
    router = json_router(completion())
    make_chat(router, api_key=None).invoke("hi")
    req = router.seen[0]
    assert str(req.url) == "http://localhost:8787/api/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-ar-v1-env"
    assert "x-anyroute-lane" not in req.headers
    assert "provider" not in router.body()


def test_missing_key_fails_clearly():
    with pytest.raises(ValueError, match="ANYROUTE_API_KEY"):
        ChatAnyroute(model="m")


def test_provider_prefs_never_loosen_the_lane():
    router = json_router(completion())
    make_chat(router, lane="public", provider={"lane": "attested", "order": ["relay"], "allow_fallbacks": False}).invoke("hi")
    assert router.seen[0].headers["x-anyroute-lane"] == "attested"
    assert router.body()["provider"] == {"lane": "attested", "order": ["relay"], "allow_fallbacks": False}


def test_include_response_headers_keeps_raw_headers():
    router = json_router(completion())
    msg = make_chat(router, include_response_headers=True).invoke("hi")
    assert msg.response_metadata["headers"]["x-receipt-id"] == "gen-test-1"
    assert msg.response_metadata["anyroute"]["receipt_id"] == "gen-test-1"


def test_no_receipt_no_metadata():
    router = json_router(completion(receipt=None), headers={"content-type": "application/json"})
    msg = make_chat(router).invoke("hi")
    assert "anyroute" not in msg.response_metadata
    assert receipt_of(msg) is None


def test_async_invoke():
    router = json_router(completion())
    msg = asyncio.run(make_chat(router, lane="attested").ainvoke("hi"))
    assert msg.response_metadata["anyroute"]["receipt"] == RECEIPT
    assert msg.response_metadata["anyroute"]["lane"] == "attested"


def sse_router() -> Router:
    def chunk(delta: dict, finish: str | None = None) -> str:
        return json.dumps(
            {"id": "gen-s", "object": "chat.completion.chunk", "created": 1, "model": "m",
             "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        )

    events = [
        chunk({"role": "assistant", "content": "Hel"}),
        chunk({"content": "lo"}),
        chunk({}, "stop"),
        json.dumps({"receipt": {**RECEIPT, "id": "gen-s"}}),
    ]
    text = "".join(f"data: {e}\n\n: anyroute-chain {i + 1} {'0' * 64}\n\n" for i, e in enumerate(events))
    text += "data: [DONE]\n\n"
    headers = {**HEADERS, "content-type": "text/event-stream", "x-receipt-id": "gen-s"}
    return Router(lambda _req: httpx.Response(200, content=text.encode(), headers=headers))


def test_stream_carries_receipt():
    router = sse_router()
    final = None
    for part in make_chat(router, lane="attested").stream("hi"):
        final = part if final is None else final + part
    assert final.content == "Hello"
    assert final.response_metadata["anyroute"] == {
        "receipt_id": "gen-s",
        "lane": "attested",
        "disclosure": "attested",
        "receipt": {**RECEIPT, "id": "gen-s"},
    }
    assert "headers" not in final.response_metadata
    assert router.body()["stream"] is True
    assert router.body()["provider"] == {"lane": "attested"}


def test_astream_carries_receipt():
    router = sse_router()

    async def run():
        final = None
        async for part in make_chat(router).astream("hi"):
            final = part if final is None else final + part
        return final

    final = asyncio.run(run())
    assert final.response_metadata["anyroute"]["receipt_id"] == "gen-s"
    assert final.response_metadata["anyroute"]["receipt"]["id"] == "gen-s"


def test_embeddings():
    router = json_router(
        {
            "object": "list",
            "model": "qwen/qwen3-embedding-8b",
            "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2, 0.3]}],
            "usage": {"prompt_tokens": 2, "total_tokens": 2},
            "receipt": RECEIPT,
        }
    )
    emb = AnyrouteEmbeddings(
        model="qwen/qwen3-embedding-8b",
        api_key="sk-ar-v1-test",
        lane="attested",
        http_client=httpx.Client(transport=httpx.MockTransport(router)),
    )
    assert emb.embed_query("hello") == pytest.approx([0.1, 0.2, 0.3])
    req = router.seen[0]
    assert str(req.url) == f"{ANYROUTE_BASE_URL}/embeddings"
    assert req.headers["x-anyroute-lane"] == "attested"
    assert router.body()["input"] == ["hello"]
