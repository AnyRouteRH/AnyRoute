# SPDX-License-Identifier: Apache-2.0
"""Anyroute embeddings: LangChain's OpenAIEmbeddings pointed at the Anyroute router."""

from __future__ import annotations

from typing import Any

from langchain_openai import OpenAIEmbeddings
from pydantic import model_validator

from ._common import Disclosure, Lane, resolve_settings


class AnyrouteEmbeddings(OpenAIEmbeddings):
    """Anyroute embeddings. Any embedding model id from GET /api/v1/models works as `model`.

    Texts are sent as text (no local tokenizer), and the lane goes in the X-Anyroute-Lane header.
    """

    lane: Lane | None = None
    """Where calls may run: "public", "attested" or "unlinkable". Sent as the X-Anyroute-Lane header."""

    disclosure: Disclosure | None = None
    """Disclosure ceiling: "any", "policy" or "none". Sent as the X-Anyroute-Disclosure-Max header."""

    provider: dict[str, Any] | None = None
    """Routing preferences; its `lane` and `disclosure` are merged into the headers, the stricter value winning."""

    @model_validator(mode="before")
    @classmethod
    def _anyroute_defaults(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        values, lane, disclosure = resolve_settings(values)
        values["lane"] = lane
        values["disclosure"] = disclosure
        # The local tokenizer only knows one vendor's models; send plain text instead.
        values.setdefault("check_embedding_ctx_length", False)
        return values
