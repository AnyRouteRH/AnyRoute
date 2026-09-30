from __future__ import annotations

import json

import httpx
import pytest

from anyroute import AsyncAnyroute, AsyncChatStream, ChatCompletion, NotFoundError, RateLimitError

from .conftest import API_KEY, BASE, KID, RID, V2, FakeRouter

pytestmark = pytest.mark.anyio

MSG = [{"role": "user", "content": "Say hello"}]


async def test_async_chat_and_receipt(aclient: AsyncAnyroute, router: FakeRouter) -> None:
    reply = await aclient.chat.completions.create(model="example/chat", messages=MSG, lane="attested")
    assert isinstance(reply, ChatCompletion) and reply.content == "Hello"
    assert reply.anyroute.receipt_id == RID and reply.anyroute.lane == "attested"
    assert json.loads(router.last.content)["provider"] == {"lane": "attested"}
    result = await aclient.receipts.verify(reply.receipt)
    assert result.valid and result.key_id == KID


async def test_async_stream_and_chain(aclient: AsyncAnyroute) -> None:
    stream = await aclient.chat.completions.stream(model="example/chat", messages=MSG)
    assert isinstance(stream, AsyncChatStream)
    chunks = [c async for c in stream]
    assert len(chunks) == 3 and stream.text == "Hello"
    assert stream.chunks == V2["chunks"]
    assert stream.verify_chain().ok
    full = await stream.verify()
    assert full.valid and full.status("v2.chain") == "pass"


async def test_async_tampered_stream(aclient: AsyncAnyroute, router: FakeRouter) -> None:
    router.tamper_stream = True
    async with await aclient.chat.completions.create(model="example/chat", messages=MSG, stream=True) as stream:
        await stream.until_done()
    assert not stream.verify_chain().ok


async def test_async_errors(aclient: AsyncAnyroute) -> None:
    with pytest.raises(RateLimitError) as e:
        await aclient.chat.completions.create(model="busy/model", messages=MSG)
    assert e.value.retry_after == 7.0
    with pytest.raises(NotFoundError):
        await aclient.presets.get("nope")


async def test_async_resources(aclient: AsyncAnyroute) -> None:
    models = await aclient.models.list(lane="attested")
    assert [m.id for m in models] == ["example/private-chat", "example/attested-chat"]
    emb = await aclient.embeddings.create(model="example/embed", input="x")
    assert emb.vectors == [[0.1, 0.2, 0.3]]
    rr = await aclient.rerank.create(model="example/reranker", query="q", documents=["a", "bb"])
    assert len(rr.results) == 2
    batch = await aclient.batches.create([{"custom_id": "q1", "body": {"model": "example/chat", "messages": MSG}}])
    done = await aclient.batches.wait(batch.id, poll_interval=0)
    assert done.status == "completed"
    results = await aclient.batches.results(batch.id)
    assert [r["custom_id"] for r in results.output] == ["q1"] and results.errors == []
    p = await aclient.presets.put("fast", models=["example/chat"])
    assert p.version == 1
    assert [x["name"] for x in await aclient.presets.list()] == ["fast"]
    assert (await aclient.presets.delete("fast")).deleted is True


async def test_async_with_lane_and_close(router: FakeRouter) -> None:
    c = AsyncAnyroute(API_KEY, base_url=BASE, http_client=httpx.AsyncClient(transport=httpx.MockTransport(router)))
    private = c.with_lane("unlinkable")
    await private.chat.completions.create(model="example/private-chat", messages=MSG)
    assert router.last.headers["x-anyroute-lane"] == "unlinkable"
    await c.close()
    owned = AsyncAnyroute(API_KEY, base_url=BASE)
    await owned.aclose()
    assert owned._http.is_closed
