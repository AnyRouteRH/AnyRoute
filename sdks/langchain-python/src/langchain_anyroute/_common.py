# SPDX-License-Identifier: Apache-2.0
"""Settings shared by the chat model and the embeddings: key, base URL, lanes and the receipt metadata."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Literal

ANYROUTE_BASE_URL = "https://api-production-70da.up.railway.app/api/v1"
"""The public Anyroute router. Point `base_url` (or ANYROUTE_BASE_URL) elsewhere to use a self-hosted router."""

Lane = Literal["public", "attested", "unlinkable"]
Disclosure = Literal["any", "policy", "none"]

_LANE_RANK = {"public": 0, "attested": 1, "unlinkable": 2}
_DISCLOSURE_RANK = {"any": 0, "policy": 1, "none": 2}


def _stricter(rank: Mapping[str, int], a: str | None, b: str | None) -> str | None:
    """The stricter of two values, so merging preferences never loosens what the caller asked for."""
    if a is None:
        return b
    if b is None:
        return a
    return b if rank.get(b, -1) > rank.get(a, -1) else a


def stricter_lane(a: str | None, b: str | None) -> str | None:
    return _stricter(_LANE_RANK, a, b)


def stricter_disclosure(a: str | None, b: str | None) -> str | None:
    return _stricter(_DISCLOSURE_RANK, a, b)


def _secret_value(value: Any) -> Any:
    getter = getattr(value, "get_secret_value", None)
    return getter() if callable(getter) else value


def resolve_settings(values: dict[str, Any]) -> tuple[dict[str, Any], str | None, str | None]:
    """Fill in the Anyroute key and base URL and add the lane headers.

    Returns the updated constructor values plus the effective lane and disclosure ceiling.
    """
    values = dict(values)
    key = values.pop("api_key", None) or values.pop("openai_api_key", None) or os.environ.get("ANYROUTE_API_KEY")
    if not _secret_value(key):
        raise ValueError("Anyroute API key missing: pass `api_key` or set the ANYROUTE_API_KEY environment variable.")
    values["api_key"] = key
    base = (
        values.pop("base_url", None)
        or values.pop("openai_api_base", None)
        or os.environ.get("ANYROUTE_BASE_URL")
        or ANYROUTE_BASE_URL
    )
    values["base_url"] = str(base).rstrip("/")

    provider = dict(values.get("provider") or {})
    lane = stricter_lane(provider.get("lane"), values.get("lane"))
    disclosure = stricter_disclosure(provider.get("disclosure"), values.get("disclosure"))
    headers = dict(values.get("default_headers") or {})
    if lane:
        headers["X-Anyroute-Lane"] = lane
    if disclosure:
        headers["X-Anyroute-Disclosure-Max"] = disclosure
    if headers:
        values["default_headers"] = headers
    return values, lane, disclosure


def build_metadata(receipt: Any, headers: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The `anyroute` entry of `response_metadata`: receipt id, lane, disclosure and the signed receipt."""
    lower = {str(k).lower(): v for k, v in (headers or {}).items()}
    receipt = receipt if isinstance(receipt, dict) else None
    receipt_id = lower.get("x-receipt-id") or (receipt or {}).get("id")
    lane = lower.get("x-anyroute-lane")
    disclosure = lower.get("x-anyroute-disclosure")
    if not (receipt_id or lane or disclosure or receipt):
        return None
    return {"receipt_id": receipt_id, "lane": lane, "disclosure": disclosure, "receipt": receipt}
