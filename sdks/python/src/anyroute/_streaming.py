"""Server-sent events from a streamed chat completion, with the receipt v2 chunk chain.

The router sends each event as ``data: <json>`` then a comment ``: anyroute-chain <i> <hex>`` carrying the chain value
after that event. The last data event before ``[DONE]`` is ``{"receipt": {...}}``; it is not chained and is not
yielded to you (read ``stream.receipt``).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, AsyncIterator, Iterator, Optional

import httpx

from .errors import error_from_body
from .receipts import CHAIN_COMMENT, ChainCheck, ChainedEvent, ReceiptVerification, check_chain
from .types import AnyrouteMeta

if TYPE_CHECKING:  # pragma: no cover
    from ._async_client import AsyncAnyroute
    from ._client import Anyroute

__all__ = ["ChatStream", "AsyncChatStream"]


class _StreamState:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.anyroute = AnyrouteMeta.from_response(response.headers)
        self.chained: list[ChainedEvent] = []
        self.receipt: Optional[dict[str, Any]] = None
        self.text_parts: list[str] = []
        self.finish_reason: Optional[str] = None
        self.usage: Optional[dict[str, Any]] = None
        self.done = False
        self.started = False
        self._lines: list[str] = []

    def feed(self, line: str) -> Optional[dict[str, Any]]:
        """Feed one line. Returns a chunk to yield when a block completes, else None."""
        if line:
            self._lines.append(line)
            return None
        block, self._lines = self._lines, []
        return self._block(block) if block else None

    def flush(self) -> Optional[dict[str, Any]]:
        block, self._lines = self._lines, []
        return self._block(block) if block else None

    def _block(self, lines: list[str]) -> Optional[dict[str, Any]]:
        data_lines: list[str] = []
        for line in lines:
            if line.startswith(":"):
                m = CHAIN_COMMENT.match(line)
                if m and self.chained and int(m.group(1)) == len(self.chained):
                    self.chained[-1].chain = m.group(2)
            elif line.startswith("data:"):
                v = line[5:]
                data_lines.append(v[1:] if v.startswith(" ") else v)
        if not data_lines:
            return None
        data = "\n".join(data_lines)
        if data == "[DONE]":
            return None
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            return None
        if not isinstance(chunk, dict):
            return None
        if isinstance(chunk.get("receipt"), dict) and "choices" not in chunk:
            self.receipt = chunk["receipt"]
            self.anyroute.receipt = self.receipt
            if not self.anyroute.receipt_id:
                self.anyroute.receipt_id = self.receipt.get("id")
            return None
        self.chained.append(ChainedEvent(data))
        if isinstance(chunk.get("error"), dict) and not chunk.get("choices"):
            raise error_from_body(self.response.status_code, chunk, headers=self.response.headers, response=self.response)
        if not self.anyroute.generation_id and isinstance(chunk.get("id"), str):
            self.anyroute.generation_id = chunk["id"]
        for choice in chunk.get("choices") or []:
            if not isinstance(choice, dict) or choice.get("index", 0) != 0:
                continue
            delta = choice.get("delta") or {}
            if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                self.text_parts.append(delta["content"])
            if choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]
        if isinstance(chunk.get("usage"), dict):
            self.usage = chunk["usage"]
        return chunk


class _StreamBase:
    _state: _StreamState

    @property
    def response(self) -> httpx.Response:
        return self._state.response

    @property
    def anyroute(self) -> AnyrouteMeta:
        """Router metadata from the response headers, plus the receipt once the stream has ended."""
        return self._state.anyroute

    @property
    def receipt(self) -> Optional[dict[str, Any]]:
        """The receipt event's ``receipt`` object (None until the stream has been read to the end)."""
        return self._state.receipt

    @property
    def chained(self) -> list[ChainedEvent]:
        """Every event before the receipt, with the chain value the router sent after it."""
        return self._state.chained

    @property
    def chunks(self) -> list[str]:
        """The exact data text of every chained event, in order (what ``verify_receipt_v2(chunks=...)`` wants)."""
        return [e.data for e in self._state.chained]

    @property
    def text(self) -> str:
        """The first choice's content deltas joined so far."""
        return "".join(self._state.text_parts)

    @property
    def finish_reason(self) -> Optional[str]:
        return self._state.finish_reason

    @property
    def usage(self) -> Optional[dict[str, Any]]:
        return self._state.usage

    @property
    def done(self) -> bool:
        return self._state.done

    def verify_chain(self) -> ChainCheck:
        """After iterating: recompute the chunk hash chain over the events received and compare it with every value
        the router sent and with the head signed in the v2 receipt. A cut, reordered or altered stream fails."""
        if not self._state.done:
            raise RuntimeError("read the stream to the end before calling verify_chain()")
        receipt = self._state.receipt or {}
        v2 = receipt.get("v2") if isinstance(receipt.get("v2"), dict) else {}
        claims = v2.get("claims") if isinstance(v2.get("claims"), dict) else {}
        resp = claims.get("resp") if isinstance(claims.get("resp"), dict) else {}
        rid = claims.get("rid") if isinstance(claims.get("rid"), str) else str(receipt.get("id") or self._state.anyroute.receipt_id or "")
        signed = resp.get("chain") if isinstance(resp.get("chain"), str) else None
        r = check_chain(rid, self._state.chained)
        return ChainCheck(r.ok and signed is not None and signed == r.head, r.head, r.first_mismatch, signed, r.events)


class ChatStream(_StreamBase):
    """A streamed chat completion. Iterate it for chunks (dicts); then read ``receipt``, ``text``, ``verify_chain()``.

    Use it as a context manager (or read it to the end) so the connection is released."""

    def __init__(self, response: httpx.Response, client: "Anyroute") -> None:
        self._state = _StreamState(response)
        self._client = client

    def __iter__(self) -> Iterator[dict[str, Any]]:
        st = self._state
        if st.started:
            raise RuntimeError("a stream can only be iterated once")
        st.started = True
        try:
            for line in st.response.iter_lines():
                chunk = st.feed(line)
                if chunk is not None:
                    yield chunk
            chunk = st.flush()
            if chunk is not None:
                yield chunk
            st.done = True
        finally:
            st.response.close()

    def until_done(self) -> "ChatStream":
        """Read (and discard) the rest of the stream."""
        if not self._state.started:
            for _ in self:
                pass
        return self

    def verify(self, *, raise_on_invalid: bool = False) -> ReceiptVerification:
        """Verify the receipt (v1 and v2, fetching the published keys) including the chain over these events."""
        self.until_done()
        if self._state.receipt is None:
            raise RuntimeError("the stream ended without a receipt")
        chain = self.verify_chain()
        result = self._client.receipts.verify(self._state.receipt, chunks=self.chunks)
        _add_chain(result, chain)
        return result.raise_if_invalid() if raise_on_invalid else result

    def close(self) -> None:
        self._state.response.close()

    def __enter__(self) -> "ChatStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncChatStream(_StreamBase):
    """The async twin of ``ChatStream``: ``async for chunk in stream``."""

    def __init__(self, response: httpx.Response, client: "AsyncAnyroute") -> None:
        self._state = _StreamState(response)
        self._client = client

    async def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        st = self._state
        if st.started:
            raise RuntimeError("a stream can only be iterated once")
        st.started = True
        try:
            async for line in st.response.aiter_lines():
                chunk = st.feed(line)
                if chunk is not None:
                    yield chunk
            chunk = st.flush()
            if chunk is not None:
                yield chunk
            st.done = True
        finally:
            await st.response.aclose()

    async def until_done(self) -> "AsyncChatStream":
        if not self._state.started:
            async for _ in self:
                pass
        return self

    async def verify(self, *, raise_on_invalid: bool = False) -> ReceiptVerification:
        await self.until_done()
        if self._state.receipt is None:
            raise RuntimeError("the stream ended without a receipt")
        chain = self.verify_chain()
        result = await self._client.receipts.verify(self._state.receipt, chunks=self.chunks)
        _add_chain(result, chain)
        return result.raise_if_invalid() if raise_on_invalid else result

    async def close(self) -> None:
        await self._state.response.aclose()

    async def __aenter__(self) -> "AsyncChatStream":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()


def _add_chain(result: ReceiptVerification, chain: ChainCheck) -> None:
    from .receipts import Check

    if chain.ok:
        result.extra.append(Check("stream_chain", "pass", f"all {chain.events} per-event chain values match and the head is the signed one"))
    else:
        where = f" at event {chain.first_mismatch}" if chain.first_mismatch else ""
        result.extra.append(Check("stream_chain", "fail", f"the per-event chain values do not match{where}"))
        result.valid = False
