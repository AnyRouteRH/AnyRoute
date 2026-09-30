# SPDX-License-Identifier: Apache-2.0
"""Anyroute chat model: LangChain's ChatOpenAI pointed at the Anyroute router, with the receipt surfaced."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any

import openai
from langchain_core.messages import AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_openai import ChatOpenAI
from pydantic import model_validator

from ._common import Disclosure, Lane, build_metadata, resolve_settings, stricter_disclosure, stricter_lane


def _receipt_of_response(response: Any) -> Any:
    if isinstance(response, dict):
        return response.get("receipt")
    extra = getattr(response, "model_extra", None) or {}
    return extra.get("receipt", getattr(response, "receipt", None))


class ChatAnyroute(ChatOpenAI):
    """An Anyroute chat model. Any id from GET /api/v1/models works as `model`.

    Every response carries `response_metadata["anyroute"]`:
    `{"receipt_id", "lane", "disclosure", "receipt"}`.

    ```python
    from langchain_anyroute import ChatAnyroute

    llm = ChatAnyroute(model="meta-llama/llama-3.3-70b-instruct", lane="attested")
    msg = llm.invoke("Say hello in five words.")
    msg.response_metadata["anyroute"]["receipt_id"]
    ```
    """

    lane: Lane | None = None
    """Where calls may run: "public", "attested" or "unlinkable". Sent as the X-Anyroute-Lane header and as
    `provider.lane` in the body."""

    disclosure: Disclosure | None = None
    """Disclosure ceiling: "any", "policy" or "none". Sent as the X-Anyroute-Disclosure-Max header and as
    `provider.disclosure` in the body."""

    provider: dict[str, Any] | None = None
    """Extra routing preferences merged into the `provider` object of the body (only, order, allow_fallbacks)."""

    expose_response_headers: bool = False
    """Also keep every response header in `response_metadata["headers"]`. The receipt headers are always in
    `response_metadata["anyroute"]`. Turned on when you pass `include_response_headers=True`."""

    @classmethod
    def get_lc_namespace(cls) -> list[str]:
        return ["langchain_anyroute", "chat_models"]

    @property
    def _llm_type(self) -> str:
        return "anyroute-chat"

    @model_validator(mode="before")
    @classmethod
    def _anyroute_defaults(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        values, lane, disclosure = resolve_settings(values)
        values["lane"] = lane
        values["disclosure"] = disclosure
        extra_body = dict(values.get("extra_body") or {})
        prefs = {**(extra_body.get("provider") or {}), **(values.get("provider") or {})}
        prefs["lane"] = stricter_lane((extra_body.get("provider") or {}).get("lane"), lane)
        prefs["disclosure"] = stricter_disclosure((extra_body.get("provider") or {}).get("disclosure"), disclosure)
        prefs = {k: v for k, v in prefs.items() if v is not None}
        if prefs:
            extra_body["provider"] = prefs
            values["extra_body"] = extra_body
        # The raw response headers carry x-receipt-id, x-anyroute-lane and x-anyroute-disclosure.
        if values.get("include_response_headers"):
            values["expose_response_headers"] = True
        values["include_response_headers"] = True
        return values

    # Chat completions: lift `receipt` out of the raw body and the receipt headers out of generation_info.
    def _create_chat_result(
        self,
        response: dict | openai.BaseModel,
        generation_info: dict | None = None,
    ) -> ChatResult:
        headers = (generation_info or {}).get("headers")
        result = super()._create_chat_result(response, generation_info)
        meta = build_metadata(_receipt_of_response(response), headers)
        if meta is not None:
            for generation in result.generations:
                generation.message.response_metadata["anyroute"] = meta
            result.llm_output = {**(result.llm_output or {}), "anyroute": meta}
        return result

    def _finish(self, result: ChatResult) -> ChatResult:
        """Fill in `anyroute` from headers where the body had no receipt (Responses API), then drop raw headers."""
        for generation in result.generations:
            info = generation.generation_info or {}
            if "anyroute" not in generation.message.response_metadata:
                headers = info.get("headers") or generation.message.response_metadata.get("headers")
                meta = build_metadata(None, headers)
                if meta is not None:
                    generation.message.response_metadata["anyroute"] = meta
            if not self.expose_response_headers:
                info.pop("headers", None)
                generation.message.response_metadata.pop("headers", None)
        return result

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        return self._finish(super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs))

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        return self._finish(await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs))

    # Streaming: the router sends `data: {"receipt": {...}}` as the last event before [DONE].
    def _convert_chunk_to_generation_chunk(
        self, chunk: dict, default_chunk_class: type, base_generation_info: dict | None
    ) -> ChatGenerationChunk | None:
        generation_chunk = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
        receipt = chunk.get("receipt") if isinstance(chunk, dict) else None
        if generation_chunk is not None and isinstance(receipt, dict):
            generation_chunk.message.response_metadata["anyroute"] = build_metadata(receipt, None)
        return generation_chunk

    def _stream_state(self) -> dict[str, Any]:
        return {"headers": None, "sent": False}

    def _on_chunk(self, state: dict[str, Any], chunk: ChatGenerationChunk) -> ChatGenerationChunk:
        info = chunk.generation_info or {}
        if state["headers"] is None and info.get("headers"):
            state["headers"] = info["headers"]
        meta = chunk.message.response_metadata.get("anyroute")
        if isinstance(meta, dict):
            chunk.message.response_metadata["anyroute"] = build_metadata(meta.get("receipt"), state["headers"])
            state["sent"] = True
        if not self.expose_response_headers:
            info.pop("headers", None)
        return chunk

    def _tail(self, state: dict[str, Any]) -> ChatGenerationChunk | None:
        if state["sent"]:
            return None
        meta = build_metadata(None, state["headers"])
        if meta is None:
            return None
        return ChatGenerationChunk(message=AIMessageChunk(content="", response_metadata={"anyroute": meta}))

    def _stream(self, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        state = self._stream_state()
        for chunk in super()._stream(*args, **kwargs):
            yield self._on_chunk(state, chunk)
        tail = self._tail(state)
        if tail is not None:
            yield tail

    async def _astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
        state = self._stream_state()
        async for chunk in super()._astream(*args, **kwargs):
            yield self._on_chunk(state, chunk)
        tail = self._tail(state)
        if tail is not None:
            yield tail


def receipt_of(message: BaseMessage) -> dict[str, Any] | None:
    """`response_metadata["anyroute"]` of a chat response: {receipt_id, lane, disclosure, receipt}, or None."""
    meta = (message.response_metadata or {}).get("anyroute")
    return meta if isinstance(meta, dict) else None
