from __future__ import annotations

import json
import os
from email.utils import formatdate

import httpx
import pytest

from anyroute import (
    Anyroute,
    APIConnectionError,
    APIError,
    AuthenticationError,
    BadRequestError,
    ChatCompletion,
    ChatStream,
    NotFoundError,
    RateLimitError,
    ReceiptInvalid,
)
from anyroute._base import DEFAULT_BASE_URL
from anyroute.errors import parse_retry_after

from .conftest import API_KEY, BASE, KID, RID, V2, FakeRouter

MSG = [{"role": "user", "content": "Say hello"}]


def test_chat_non_stream_returns_completion_with_meta(client: Anyroute, router: FakeRouter) -> None:
    reply = client.chat.completions.create(model="example/chat", messages=MSG, temperature=0.2)
    assert isinstance(reply, ChatCompletion)
    assert reply.content == "Hello"
    assert reply["choices"][0]["finish_reason"] == "stop"
    assert reply.usage["total_tokens"] == 15  # attribute access to top-level keys
    meta = reply.anyroute
    assert meta.generation_id == RID and meta.receipt_id == RID
    assert meta.lane == "public" and meta.disclosure == "vendor-forwarded"
    assert meta.policy_hash == "0x" + "cd" * 32
    assert meta.receipt is not None and meta.receipt["key_id"] == KID
    sent = router.last
    assert sent.headers["authorization"] == f"Bearer {API_KEY}"
    assert sent.url == f"{BASE}/api/v1/chat/completions"
    assert json.loads(sent.content) == {"model": "example/chat", "messages": MSG, "temperature": 0.2}
    assert "x-anyroute-lane" not in sent.headers


def test_chat_receipt_verifies_v1_and_v2_with_cached_keys(client: Anyroute, router: FakeRouter) -> None:
    reply = client.chat.completions.create(model="example/chat", messages=MSG)
    result = client.receipts.verify(reply.receipt)
    assert result.valid, result.failures
    assert result.v1 is not None and result.v1.valid
    assert result.v2 is not None and result.v2.valid
    assert result.key_id == KID
    assert result.status("v1.signature") == "pass" and result.status("v2.signature") == "pass"
    assert result.status("rid") == "pass"
    client.receipts.verify(reply.receipt)
    assert router.key_fetches == 1  # keys are cached


def test_chat_stream_yields_chunks_and_verifies_chain(client: Anyroute, router: FakeRouter) -> None:
    with client.chat.completions.stream(model="example/chat", messages=MSG) as stream:
        chunks = list(stream)
    assert json.loads(router.last.content)["stream"] is True
    assert router.last.headers["accept"] == "text/event-stream"
    assert len(chunks) == 3  # the receipt event is not yielded
    assert all("choices" in c for c in chunks)
    assert stream.text == "Hello" and stream.finish_reason == "stop"
    assert stream.chunks == V2["chunks"]
    assert [e.chain for e in stream.chained] == V2["chain_steps"]
    assert stream.receipt is not None and stream.receipt["id"] == RID
    assert stream.anyroute.receipt_id == RID and stream.anyroute.receipt == stream.receipt
    chain = stream.verify_chain()
    assert chain.ok and chain.head == V2["claims"]["resp"]["chain"] and chain.signed_head == chain.head
    full = stream.verify()
    assert full.valid, full.failures
    assert full.status("v2.chain") == "pass" and full.status("stream_chain") == "pass"


def test_create_with_stream_true_returns_a_stream(client: Anyroute) -> None:
    stream = client.chat.completions.create(model="example/chat", messages=MSG, stream=True)
    assert isinstance(stream, ChatStream)
    stream.until_done()
    assert stream.verify_chain().ok


def test_tampered_stream_fails_the_chain(client: Anyroute, router: FakeRouter) -> None:
    router.tamper_stream = True
    stream = client.chat.completions.stream(model="example/chat", messages=MSG)
    for _ in stream:
        pass
    assert stream.text == "HelLO"
    chain = stream.verify_chain()
    assert not chain.ok and chain.first_mismatch == 2
    result = stream.verify()
    assert not result.valid
    assert result.status("v2.chain") == "fail" and result.status("stream_chain") == "fail"
    with pytest.raises(ReceiptInvalid):
        client.chat.completions.stream(model="example/chat", messages=MSG).verify(raise_on_invalid=True)


def test_verify_chain_before_the_end_raises(client: Anyroute) -> None:
    stream = client.chat.completions.stream(model="example/chat", messages=MSG)
    with pytest.raises(RuntimeError):
        stream.verify_chain()
    stream.close()


def test_rate_limit_raises_with_retry_after(client: Anyroute) -> None:
    with pytest.raises(RateLimitError) as info:
        client.chat.completions.create(model="busy/model", messages=MSG)
    e = info.value
    assert e.status == 429 and e.code == 429
    assert e.type == "rate_limited"
    assert e.retry_after == 7.0
    assert e.metadata == {"limit": 60}
    assert "Rate limit exceeded" in e.message and "retry after 7s" in str(e)


def test_stream_errors_raise_before_iteration(client: Anyroute) -> None:
    with pytest.raises(RateLimitError) as info:
        client.chat.completions.stream(model="busy/model", messages=MSG)
    assert info.value.retry_after == 7.0


def test_error_classes_by_status(router: FakeRouter, client: Anyroute) -> None:
    with pytest.raises(NotFoundError) as nf:
        client.chat.completions.create(model="missing/model", messages=MSG)
    assert nf.value.type == "model_not_found"
    with pytest.raises(BadRequestError):
        client.chat.completions.create(model="example/chat", messages=[])
    with pytest.raises(APIError) as api:
        client.chat.completions.create(model="broken/model", messages=MSG)
    assert api.value.status == 502
    bad = Anyroute("wrong-key", base_url=BASE, http_client=httpx.Client(transport=httpx.MockTransport(router)))
    with pytest.raises(AuthenticationError) as auth:
        bad.chat.completions.create(model="example/chat", messages=MSG)
    assert auth.value.status == 401


def test_connection_errors_are_wrapped(router: FakeRouter, client: Anyroute) -> None:
    router.fail_connect = True
    with pytest.raises(APIConnectionError):
        client.models.list()


def test_retry_after_parsing() -> None:
    assert parse_retry_after("3") == 3.0
    assert parse_retry_after("1.5") == 1.5
    assert parse_retry_after("-4") == 0.0
    assert parse_retry_after(None) is None and parse_retry_after("soon") is None
    now = 1_790_000_000.0
    assert parse_retry_after(formatdate(now + 30, usegmt=True), now=now) == pytest.approx(30.0)
    assert parse_retry_after(formatdate(now - 30, usegmt=True), now=now) == 0.0


def test_env_defaults_and_base_url_normalizing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANYROUTE_API_KEY", "sk-env")
    monkeypatch.delenv("ANYROUTE_BASE_URL", raising=False)
    c = Anyroute()
    assert c.api_key == "sk-env" and c.base_url == DEFAULT_BASE_URL
    c.close()
    monkeypatch.setenv("ANYROUTE_BASE_URL", "https://example.test/api/v1/")
    with Anyroute() as c2:
        assert c2.base_url == "https://example.test"
    assert os.environ["ANYROUTE_API_KEY"] == "sk-env"


def test_default_headers_and_extra_headers(router: FakeRouter) -> None:
    c = Anyroute(API_KEY, base_url=BASE, default_headers={"X-Title": "demo"}, http_client=httpx.Client(transport=httpx.MockTransport(router)))
    c.chat.completions.create(model="example/chat", messages=MSG, extra_headers={"X-Trace": "t1"}, extra_body={"user": "u1"})
    assert router.last.headers["x-title"] == "demo" and router.last.headers["x-trace"] == "t1"
    assert json.loads(router.last.content)["user"] == "u1"
    assert router.last.headers["user-agent"].startswith("anyroute-python/")
