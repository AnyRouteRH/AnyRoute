"""What the sync and async clients share: configuration, headers, lane merging, request bodies and response parsing."""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Mapping, Optional, Sequence
from urllib.parse import quote

import httpx

from ._version import __version__
from .errors import APIConnectionError, APITimeoutError
from .lanes import DISCLOSURE_HEADER, LANE_HEADER, check_disclosure, check_lane, merge_provider, stricter_disclosure, stricter_lane
from .receipts import decode_receipt_v2, parse_key_set
from .types import AnyrouteMeta, APIResponse, DataList

DEFAULT_BASE_URL = "https://api-production-70da.up.railway.app"
API_PREFIX = "/api/v1"
RECEIPT_KEYS_PATH = "/.well-known/anyroute-receipt-keys.json"
DEFAULT_TIMEOUT = 120.0
KEYS_TTL_SECONDS = 3600.0

NOT_GIVEN: Any = object()


def normalize_base_url(url: str) -> str:
    u = url.strip().rstrip("/")
    for suffix in ("/api/v1", "/v1"):
        if u.endswith(suffix):
            u = u[: -len(suffix)]
            break
    return u


def drop_none(d: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def seg(value: str) -> str:
    """One URL path segment, escaped."""
    return quote(str(value), safe="")


class KeyCache:
    """The published receipt keys, shared by a client and its copies."""

    def __init__(self) -> None:
        self.keys: Optional[list[dict[str, Any]]] = None
        self.fetched_at = 0.0
        self.lock = threading.Lock()

    def fresh(self) -> Optional[list[dict[str, Any]]]:
        if self.keys is not None and time.monotonic() - self.fetched_at < KEYS_TTL_SECONDS:
            return self.keys
        return None

    def store(self, body: Any) -> list[dict[str, Any]]:
        keys = parse_key_set(body)
        with self.lock:
            self.keys, self.fetched_at = keys, time.monotonic()
        return keys


def receipt_key_ids(receipt: Any) -> set[str]:
    """Every key id a receipt names (v1 ``key_id``, v2 ``kid`` or the COSE protected header)."""
    ids: set[str] = set()
    if isinstance(receipt, (bytes, bytearray, str)):
        try:
            ids.add(decode_receipt_v2(receipt).key_id)
        except Exception:
            pass
        return ids
    if not isinstance(receipt, Mapping):
        return ids
    if isinstance(receipt.get("key_id"), str):
        ids.add(receipt["key_id"])
    v2 = receipt.get("v2") if isinstance(receipt.get("v2"), Mapping) else (receipt if "cose" in receipt else None)
    if v2:
        if isinstance(v2.get("kid"), str):
            ids.add(v2["kid"])
        try:
            ids.add(decode_receipt_v2(v2["cose"]).key_id)
        except Exception:
            pass
    ids.discard("")
    return ids


class BaseClient:
    def __init__(
        self,
        *,
        api_key: Optional[str],
        base_url: Optional[str],
        lane: Optional[str],
        disclosure: Optional[str],
        timeout: Any,
        default_headers: Optional[Mapping[str, str]],
    ) -> None:
        self.api_key = api_key if api_key is not None else os.environ.get("ANYROUTE_API_KEY")
        self.base_url = normalize_base_url(base_url or os.environ.get("ANYROUTE_BASE_URL") or DEFAULT_BASE_URL)
        self.lane = check_lane(lane)
        self.disclosure = check_disclosure(disclosure)
        self.timeout = timeout
        self.default_headers: dict[str, str] = dict(default_headers or {})
        self._keys = KeyCache()

    # ---- request building ----------------------------------------------------------------------------------------

    def _url(self, path: str, *, root: bool = False) -> str:
        return self.base_url + ("" if root else API_PREFIX) + path

    def _headers(self, lane: Optional[str], disclosure: Optional[str], extra: Optional[Mapping[str, str]], accept: str) -> dict[str, str]:
        h = {"accept": accept, "user-agent": f"anyroute-python/{__version__}"}
        if self.api_key:
            h["authorization"] = f"Bearer {self.api_key}"
        h.update(self.default_headers)
        if lane:
            h[LANE_HEADER] = lane
        if disclosure:
            h[DISCLOSURE_HEADER] = disclosure
        if extra:
            h.update(extra)
        return h

    def _build(
        self,
        http: "httpx.Client | httpx.AsyncClient",
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        merge_body: bool = False,
        extra_headers: Optional[Mapping[str, str]] = None,
        timeout: Any = None,
        root: bool = False,
        accept: str = "application/json",
    ) -> httpx.Request:
        eff_lane = stricter_lane(self.lane, check_lane(lane))
        eff_disc = stricter_disclosure(self.disclosure, check_disclosure(disclosure))
        if merge_body and isinstance(json_body, Mapping):
            json_body = merge_provider(json_body, eff_lane, eff_disc)
            prov = json_body.get("provider") if isinstance(json_body.get("provider"), Mapping) else {}
            eff_lane = stricter_lane(eff_lane, prov.get("lane")) or eff_lane
            eff_disc = stricter_disclosure(eff_disc, prov.get("disclosure")) or eff_disc
        headers = self._headers(eff_lane, eff_disc, extra_headers, accept)
        kwargs: dict[str, Any] = {"headers": headers}
        if params:
            kwargs["params"] = {k: ("true" if v is True else "false" if v is False else v) for k, v in params.items() if v is not None}
        if json_body is not None:
            kwargs["content"] = json.dumps(json_body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json"
        if timeout is not None:
            kwargs["timeout"] = timeout
        elif self.timeout is not None:
            kwargs["timeout"] = self.timeout
        return http.build_request(method, self._url(path, root=root), **kwargs)


def wrap_transport_error(e: Exception) -> Exception:
    if isinstance(e, httpx.TimeoutException):
        return APITimeoutError(f"request timed out: {e}")
    return APIConnectionError(f"connection error: {e}")


def json_body(response: httpx.Response) -> Any:
    try:
        return response.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return {}


def unwrap(response: httpx.Response, cls: type = APIResponse) -> Any:
    """``{data: {...}}`` becomes the inner object; ``{data: [...], ...}`` becomes a DataList with the rest as extras."""
    body = json_body(response)
    meta = AnyrouteMeta.from_response(response.headers)
    if isinstance(body, Mapping) and "data" in body:
        data = body["data"]
        extra = {k: v for k, v in body.items() if k != "data"}
        if isinstance(data, list):
            return DataList([cls(x, meta=None) if isinstance(x, Mapping) else x for x in data], extra=extra, meta=meta)
        if isinstance(data, Mapping):
            return cls(data, meta=meta)
    return cls(body if isinstance(body, Mapping) else {"data": body}, meta=meta)


def parse_jsonl(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


# ---- request bodies --------------------------------------------------------------------------------------------------


def chat_body(model: Optional[str], messages: Any, provider: Any, params: Mapping[str, Any], extra_body: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    body = drop_none({"model": model, "messages": messages, "provider": provider, **params})
    body.update(extra_body or {})
    return body


def batch_body(
    requests: Optional[Sequence[Mapping[str, Any]]],
    input_jsonl: Optional[str],
    endpoint: Optional[str],
    completion_window: Optional[str],
    metadata: Optional[Mapping[str, Any]],
    lane: Optional[str],
    disclosure: Optional[str],
) -> dict[str, Any]:
    if (requests is None) == (input_jsonl is None):
        raise ValueError("pass exactly one of requests or input_jsonl")
    body: dict[str, Any] = drop_none({"endpoint": endpoint, "completion_window": completion_window, "metadata": metadata})
    if input_jsonl is not None:
        body["input_jsonl"] = input_jsonl
        return body
    url = endpoint or "/v1/chat/completions"
    reqs = []
    for i, r in enumerate(requests or []):
        if not isinstance(r, Mapping) or not isinstance(r.get("body"), Mapping):
            raise ValueError(f"request {i} needs a body object")
        item = {"custom_id": r.get("custom_id") or f"request-{i + 1}", "method": r.get("method") or "POST", "url": r.get("url") or url, "body": dict(r["body"])}
        if lane or disclosure:
            item["body"] = merge_provider(item["body"], lane, disclosure)
        reqs.append(item)
    body["requests"] = reqs
    return body


def preset_body(**fields: Any) -> dict[str, Any]:
    extra = fields.pop("extra", None) or {}
    body = drop_none(fields)
    body.update(extra)
    return body


def modalities_param(output_modalities: Any) -> Optional[str]:
    if output_modalities is None:
        return None
    if isinstance(output_modalities, str):
        return output_modalities
    return ",".join(output_modalities)


def filter_models(items: DataList, lane: Optional[str]) -> DataList:
    if lane is None:
        return items
    check_lane(lane)
    return DataList([m for m in items if m.supports_lane(lane)], extra=items.extra, meta=items.anyroute)
