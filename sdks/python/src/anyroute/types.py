"""Response types. Every response is a plain ``dict`` (so it serializes and prints as the JSON the router sent) with
attribute access to its top-level keys and an ``anyroute`` field holding the router's metadata."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterator, Mapping, Optional

__all__ = [
    "AnyrouteMeta",
    "APIResponse",
    "ChatCompletion",
    "Embeddings",
    "Rerank",
    "Batch",
    "BatchResults",
    "DataList",
    "Model",
    "TERMINAL_BATCH_STATUSES",
]

TERMINAL_BATCH_STATUSES = frozenset({"completed", "failed", "expired", "cancelled"})


@dataclass
class AnyrouteMeta:
    """What the router says about a generation, from its response headers and the attached receipt."""

    generation_id: Optional[str] = None
    receipt_id: Optional[str] = None
    lane: Optional[str] = None
    disclosure: Optional[str] = None
    policy_hash: Optional[str] = None
    receipt: Optional[dict[str, Any]] = None
    headers: dict[str, str] = field(default_factory=dict, repr=False)

    @classmethod
    def from_response(cls, headers: Mapping[str, str], body: Any = None) -> "AnyrouteMeta":
        h = {k.lower(): v for k, v in headers.items()}
        receipt = body.get("receipt") if isinstance(body, Mapping) and isinstance(body.get("receipt"), Mapping) else None
        return cls(
            generation_id=h.get("x-generation-id") or (body.get("id") if isinstance(body, Mapping) and isinstance(body.get("id"), str) else None),
            receipt_id=h.get("x-receipt-id") or (receipt.get("id") if receipt else None),
            lane=h.get("x-anyroute-lane"),
            disclosure=h.get("x-anyroute-disclosure"),
            policy_hash=h.get("x-anyroute-policy-hash"),
            receipt=dict(receipt) if receipt else None,
            headers=h,
        )


class APIResponse(dict):
    """A JSON object from the router. ``resp["key"]`` and ``resp.key`` both work; ``resp.anyroute`` is metadata."""

    anyroute: Optional[AnyrouteMeta]

    def __init__(self, data: Optional[Mapping[str, Any]] = None, *, meta: Optional[AnyrouteMeta] = None) -> None:
        super().__init__(data or {})
        self.anyroute = meta

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        try:
            return self[name]
        except KeyError:
            raise AttributeError(f"{type(self).__name__} has no field {name!r}") from None

    def to_dict(self) -> dict[str, Any]:
        return dict(self)

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self, **kwargs)


class ChatCompletion(APIResponse):
    """An OpenAI style ``chat.completion`` plus the router's ``receipt``."""

    @property
    def content(self) -> Optional[str]:
        """The first choice's message content, if any."""
        try:
            return self["choices"][0]["message"].get("content")
        except (KeyError, IndexError, TypeError, AttributeError):
            return None

    @property
    def receipt(self) -> Optional[dict[str, Any]]:
        r = self.get("receipt")
        return r if isinstance(r, dict) else None


class Embeddings(APIResponse):
    @property
    def vectors(self) -> list[list[float]]:
        """The embedding vectors in input order."""
        items = sorted(self.get("data") or [], key=lambda d: d.get("index", 0))
        return [d.get("embedding") for d in items]

    @property
    def receipt(self) -> Optional[dict[str, Any]]:
        r = self.get("receipt")
        return r if isinstance(r, dict) else None


class Rerank(APIResponse):
    @property
    def receipt(self) -> Optional[dict[str, Any]]:
        r = self.get("receipt")
        return r if isinstance(r, dict) else None


class Batch(APIResponse):
    @property
    def is_terminal(self) -> bool:
        return self.get("status") in TERMINAL_BATCH_STATUSES


class Model(APIResponse):
    """One entry from ``GET /api/v1/models``."""

    @property
    def lanes(self) -> list[str]:
        lanes = self.get("lanes")
        return list(lanes) if isinstance(lanes, list) else ["public"]

    def supports_lane(self, lane: str) -> bool:
        return lane in self.lanes


class DataList(list):
    """A list from a ``{data: [...], ...}`` envelope. The envelope's other keys are attributes (``.extra`` holds them)."""

    def __init__(self, items: Any = (), *, extra: Optional[Mapping[str, Any]] = None, meta: Optional[AnyrouteMeta] = None) -> None:
        super().__init__(items)
        self.extra: dict[str, Any] = dict(extra or {})
        self.anyroute = meta

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__") or name == "extra":
            raise AttributeError(name)
        try:
            return self.extra[name]
        except KeyError:
            raise AttributeError(f"list has no field {name!r}") from None


@dataclass
class BatchResults:
    """The parsed JSONL of a finished batch. Each line: ``{id, custom_id, response: {status_code, body} | None,
    error: {code, message} | None}``."""

    batch_id: str
    output: list[dict[str, Any]]
    errors: list[dict[str, Any]]

    def __iter__(self) -> Iterator[dict[str, Any]]:
        yield from self.output
        yield from self.errors

    def __len__(self) -> int:
        return len(self.output) + len(self.errors)

    def by_custom_id(self) -> dict[str, dict[str, Any]]:
        return {line["custom_id"]: line for line in self if isinstance(line.get("custom_id"), str)}

    def bodies(self) -> dict[str, Any]:
        """custom_id to response body, for the requests that succeeded."""
        out: dict[str, Any] = {}
        for line in self.output:
            resp = line.get("response")
            if isinstance(resp, dict) and isinstance(line.get("custom_id"), str):
                out[line["custom_id"]] = resp.get("body")
        return out
