# SPDX-License-Identifier: Apache-2.0
"""Anyroute LLM for LlamaIndex: OpenAILike pointed at the Anyroute router, with the receipt surfaced."""

from __future__ import annotations

import os
from typing import Any, Dict, Literal, Optional, Sequence

from llama_index.core.base.llms.types import ChatMessage, ChatResponse, ChatResponseAsyncGen, ChatResponseGen
from llama_index.core.bridge.pydantic import Field
from llama_index.llms.openai_like import OpenAILike

ANYROUTE_BASE_URL = "https://api-production-70da.up.railway.app/api/v1"
"""The public Anyroute router. Point `api_base` (or ANYROUTE_BASE_URL) elsewhere to use a self-hosted router."""

Lane = Literal["public", "attested", "unlinkable"]
Disclosure = Literal["any", "policy", "none"]

_LANE_RANK = {"public": 0, "attested": 1, "unlinkable": 2}
_DISCLOSURE_RANK = {"any": 0, "policy": 1, "none": 2}


def _stricter(rank: Dict[str, int], a: Optional[str], b: Optional[str]) -> Optional[str]:
    """The stricter of two values, so merging preferences never loosens what the caller asked for."""
    if a is None:
        return b
    if b is None:
        return a
    return b if rank.get(b, -1) > rank.get(a, -1) else a


def _raw_receipt(raw: Any) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if isinstance(raw, dict):
        receipt = raw.get("receipt")
    else:
        extra = getattr(raw, "model_extra", None) or {}
        receipt = extra.get("receipt", getattr(raw, "receipt", None))
    return receipt if isinstance(receipt, dict) else None


def _metadata(receipt: Dict[str, Any]) -> Dict[str, Any]:
    claims = (receipt.get("v2") or {}).get("claims") or {}
    payload = receipt.get("payload") or {}
    return {
        "receipt_id": receipt.get("id") or claims.get("rid") or payload.get("rid"),
        "lane": claims.get("lane") or payload.get("lane"),
        "disclosure": claims.get("disclosure") or payload.get("disclosure"),
        "receipt": receipt,
    }


def receipt_of(response: Any) -> Optional[Dict[str, Any]]:
    """The receipt of an Anyroute chat response: {receipt_id, lane, disclosure, receipt}, or None.

    Works on a `ChatResponse` from `chat`/`achat`, on the last `ChatResponse` of a stream (the router sends the
    receipt as the final event), and on a `CompletionResponse`.
    """
    extra = getattr(response, "additional_kwargs", None) or {}
    if isinstance(extra.get("anyroute"), dict):
        return extra["anyroute"]
    receipt = _raw_receipt(getattr(response, "raw", None))
    return _metadata(receipt) if receipt else None


def _tag(response: Any) -> Any:
    """Copy the receipt from `raw` into `additional_kwargs["anyroute"]`."""
    receipt = _raw_receipt(getattr(response, "raw", None))
    if receipt is not None:
        response.additional_kwargs = {**(response.additional_kwargs or {}), "anyroute": _metadata(receipt)}
    return response


def _with_choices(chunk: Any) -> Any:
    # The router's last stream event is `{"receipt": {...}}` with no `choices`; give it an empty list so the
    # stream reader treats it as an empty chunk and passes it on (with the receipt in `raw`) instead of failing.
    if getattr(chunk, "choices", None) is None:
        try:
            chunk.choices = []
        except Exception:  # pragma: no cover - a frozen model would keep its own value
            pass
    return chunk


class _Delegate:
    """Forwards every attribute to the wrapped object unless this class defines it."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class _SyncCompletions(_Delegate):
    def create(self, *args: Any, **kwargs: Any) -> Any:
        result = self._inner.create(*args, **kwargs)
        if not kwargs.get("stream"):
            return result
        return (_with_choices(chunk) for chunk in result)


class _AsyncCompletions(_Delegate):
    async def create(self, *args: Any, **kwargs: Any) -> Any:
        result = await self._inner.create(*args, **kwargs)
        if not kwargs.get("stream"):
            return result

        async def chunks() -> Any:
            async for chunk in result:
                yield _with_choices(chunk)

        return chunks()


class _Chat(_Delegate):
    def __init__(self, inner: Any, completions: Any) -> None:
        super().__init__(inner)
        self.completions = completions


class _SyncClient(_Delegate):
    def __init__(self, inner: Any) -> None:
        super().__init__(inner)
        self.chat = _Chat(inner.chat, _SyncCompletions(inner.chat.completions))

    def __enter__(self) -> "_SyncClient":
        self._inner.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._inner.__exit__(*exc)


class _AsyncClient(_Delegate):
    def __init__(self, inner: Any) -> None:
        super().__init__(inner)
        self.chat = _Chat(inner.chat, _AsyncCompletions(inner.chat.completions))

    async def __aenter__(self) -> "_AsyncClient":
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._inner.__aexit__(*exc)


class Anyroute(OpenAILike):
    """Anyroute for LlamaIndex. Any id from GET /api/v1/models works as `model`.

    ```python
    from llama_index.llms.anyroute import Anyroute, receipt_of

    llm = Anyroute(model="meta-llama/llama-3.3-70b-instruct", lane="attested")
    resp = llm.chat([ChatMessage(role="user", content="Say hello in five words.")])
    receipt_of(resp)  # {"receipt_id", "lane", "disclosure", "receipt"}
    ```
    """

    lane: Optional[Lane] = Field(
        default=None,
        description='Where calls may run: "public", "attested" or "unlinkable". Sent as X-Anyroute-Lane and provider.lane.',
    )
    disclosure: Optional[Disclosure] = Field(
        default=None,
        description='Disclosure ceiling: "any", "policy" or "none". Sent as X-Anyroute-Disclosure-Max and provider.disclosure.',
    )
    provider: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Extra routing preferences merged into the provider object of the body (only, order, allow_fallbacks).",
    )

    def __init__(
        self,
        model: str,
        api_key: Optional[str] = None,
        api_base: Optional[str] = None,
        lane: Optional[Lane] = None,
        disclosure: Optional[Disclosure] = None,
        provider: Optional[Dict[str, Any]] = None,
        default_headers: Optional[Dict[str, str]] = None,
        additional_kwargs: Optional[Dict[str, Any]] = None,
        is_chat_model: bool = True,
        is_function_calling_model: bool = True,
        context_window: int = 131072,
        **kwargs: Any,
    ) -> None:
        key = api_key or os.environ.get("ANYROUTE_API_KEY")
        if not key:
            raise ValueError("Anyroute API key missing: pass `api_key` or set the ANYROUTE_API_KEY environment variable.")
        base = (api_base or os.environ.get("ANYROUTE_BASE_URL") or ANYROUTE_BASE_URL).rstrip("/")

        extra = dict(additional_kwargs or {})
        extra_body = dict(extra.get("extra_body") or {})
        existing = dict(extra_body.get("provider") or {})
        prefs = {**existing, **(provider or {})}
        prefs["lane"] = _stricter(_LANE_RANK, _stricter(_LANE_RANK, existing.get("lane"), (provider or {}).get("lane")), lane)
        prefs["disclosure"] = _stricter(
            _DISCLOSURE_RANK,
            _stricter(_DISCLOSURE_RANK, existing.get("disclosure"), (provider or {}).get("disclosure")),
            disclosure,
        )
        prefs = {k: v for k, v in prefs.items() if v is not None}
        if prefs:
            extra_body["provider"] = prefs
            extra["extra_body"] = extra_body

        headers = dict(default_headers or {})
        if prefs.get("lane"):
            headers["X-Anyroute-Lane"] = prefs["lane"]
        if prefs.get("disclosure"):
            headers["X-Anyroute-Disclosure-Max"] = prefs["disclosure"]

        super().__init__(
            model=model,
            api_key=key,
            api_base=base,
            default_headers=headers or None,
            additional_kwargs=extra,
            is_chat_model=is_chat_model,
            is_function_calling_model=is_function_calling_model,
            context_window=context_window,
            lane=prefs.get("lane"),
            disclosure=prefs.get("disclosure"),
            provider=provider,
            **kwargs,
        )

    @classmethod
    def class_name(cls) -> str:
        return "Anyroute"

    def _get_client(self) -> Any:
        return _SyncClient(super()._get_client())

    def _get_aclient(self) -> Any:
        return _AsyncClient(super()._get_aclient())

    def _chat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponse:
        return _tag(super()._chat(messages, **kwargs))

    async def _achat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponse:
        return _tag(await super()._achat(messages, **kwargs))

    def _stream_chat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponseGen:
        inner = super()._stream_chat(messages, **kwargs)

        def gen() -> ChatResponseGen:
            for response in inner:
                yield _tag(response)

        return gen()

    async def _astream_chat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponseAsyncGen:
        inner = await super()._astream_chat(messages, **kwargs)

        async def gen() -> ChatResponseAsyncGen:
            async for response in inner:
                yield _tag(response)

        return gen()
