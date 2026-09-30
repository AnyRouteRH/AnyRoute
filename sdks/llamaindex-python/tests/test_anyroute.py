# SPDX-License-Identifier: Apache-2.0
"""Offline tests: an httpx MockTransport plays the router, so nothing leaves the machine."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from llama_index.core.base.llms.types import ChatMessage

from llama_index.llms.anyroute import ANYROUTE_BASE_URL, Anyroute, receipt_of

RECEIPT = {
    "id": "gen-test-1",
    "sig": "c2lnbmF0dXJl",
    "key_id": "21fe31dfa154a261",
    "alg": "Ed25519",
    "payload": {"rid": "gen-test-1"},
    "leaf": "0xabc",
    "v2": {"alg": "EdDSA", "kid": "21fe31dfa154a261", "claims": {"v": 2, "rid": "gen-test-1", "lane": "attested", "disclosure": "attested"}},
}

HEADERS = {"content-type": "application/json", "x-receipt-id": "gen-test-1", "x-anyroute-lane": "attested"}

HELLO = [ChatMessage(role="user", content="Say hello in five words.")]


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
    def __init__(self, respond):
        self.respond = respond
        self.seen: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        return self.respond(request)

    def body(self, i: int = 0) -> dict[str, Any]:
        return json.loads(self.seen[i].content)


def json_router(body: dict[str, Any]) -> Router:
    return Router(lambda _req: httpx.Response(200, json=body, headers=HEADERS))


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


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("ANYROUTE_API_KEY", "ANYROUTE_BASE_URL", "OPENAI_API_KEY", "OPENAI_API_BASE", "OPENAI_BASE_URL"):
        monkeypatch.delenv(name, raising=False)


def make_llm(router: Router, **kwargs: Any) -> Anyroute:
    kwargs.setdefault("api_key", "sk-ar-v1-test")
    return Anyroute(
        model="meta-llama/llama-3.3-70b-instruct",
        http_client=httpx.Client(transport=httpx.MockTransport(router)),
        async_http_client=httpx.AsyncClient(transport=httpx.MockTransport(router)),
        max_retries=0,
        **kwargs,
    )


def test_chat_sends_lane_and_surfaces_receipt():
    router = json_router(completion())
    resp = make_llm(router, lane="attested", disclosure="policy").chat(HELLO)

    assert resp.message.content == "Hello there, friend of mine."
    meta = {"receipt_id": "gen-test-1", "lane": "attested", "disclosure": "attested", "receipt": RECEIPT}
    assert receipt_of(resp) == meta
    assert resp.additional_kwargs["anyroute"] == meta
    assert resp.raw.model_extra["receipt"] == RECEIPT

    req = router.seen[0]
    assert str(req.url) == f"{ANYROUTE_BASE_URL}/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-ar-v1-test"
    assert req.headers["x-anyroute-lane"] == "attested"
    assert req.headers["x-anyroute-disclosure-max"] == "policy"
    assert router.body()["provider"] == {"lane": "attested", "disclosure": "policy"}
    assert router.body()["model"] == "meta-llama/llama-3.3-70b-instruct"


def test_key_and_base_url_from_env(monkeypatch):
    monkeypatch.setenv("ANYROUTE_API_KEY", "sk-ar-v1-env")
    monkeypatch.setenv("ANYROUTE_BASE_URL", "http://localhost:8787/api/v1/")
    router = json_router(completion())
    make_llm(router, api_key=None).chat(HELLO)
    req = router.seen[0]
    assert str(req.url) == "http://localhost:8787/api/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-ar-v1-env"
    assert "x-anyroute-lane" not in req.headers
    assert "provider" not in router.body()


def test_missing_key_fails_clearly():
    with pytest.raises(ValueError, match="ANYROUTE_API_KEY"):
        Anyroute(model="m")


def test_provider_prefs_never_loosen_the_lane():
    router = json_router(completion())
    make_llm(router, lane="public", provider={"lane": "attested", "order": ["relay"]}).chat(HELLO)
    assert router.seen[0].headers["x-anyroute-lane"] == "attested"
    assert router.body()["provider"] == {"lane": "attested", "order": ["relay"]}


def test_no_receipt():
    router = json_router(completion(receipt=None))
    resp = make_llm(router).chat(HELLO)
    assert receipt_of(resp) is None
    assert "anyroute" not in resp.additional_kwargs


def test_complete_uses_chat_and_keeps_receipt():
    router = json_router(completion())
    resp = make_llm(router).complete("Say hello")
    assert resp.text == "Hello there, friend of mine."
    assert receipt_of(resp)["receipt_id"] == "gen-test-1"


def test_achat():
    router = json_router(completion())
    resp = asyncio.run(make_llm(router, lane="attested").achat(HELLO))
    assert receipt_of(resp)["lane"] == "attested"


def test_stream_chat_last_response_has_receipt():
    router = sse_router()
    responses = list(make_llm(router, lane="attested").stream_chat(HELLO))
    assert responses[-1].message.content == "Hello"
    meta = receipt_of(responses[-1])
    assert meta["receipt_id"] == "gen-s"
    assert meta["lane"] == "attested"
    assert router.body()["stream"] is True
    assert router.body()["provider"] == {"lane": "attested"}


def test_astream_chat_last_response_has_receipt():
    router = sse_router()

    async def run():
        out = []
        async for r in await make_llm(router).astream_chat(HELLO):
            out.append(r)
        return out

    responses = asyncio.run(run())
    assert receipt_of(responses[-1])["receipt"]["id"] == "gen-s"


def test_fresh_client_per_call():
    router = json_router(completion())
    llm = make_llm(router, reuse_client=False)
    assert receipt_of(llm.chat(HELLO))["receipt_id"] == "gen-test-1"
    assert receipt_of(asyncio.run(llm.achat(HELLO)))["receipt_id"] == "gen-test-1"
