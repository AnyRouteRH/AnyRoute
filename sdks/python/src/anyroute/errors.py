"""Errors raised by the Anyroute clients.

Every HTTP error body from the router looks like ``{"error": {"code": 429, "message": "...", "type": "rate_limited",
"metadata": {...}}}``. The client turns it into the matching subclass of ``AnyrouteError``.
"""

from __future__ import annotations

import email.utils
import json
import time
from typing import TYPE_CHECKING, Any, Mapping

if TYPE_CHECKING:  # pragma: no cover
    import httpx

    from .receipts import ReceiptVerification

__all__ = [
    "AnyrouteError",
    "APIError",
    "APIConnectionError",
    "APITimeoutError",
    "AuthenticationError",
    "BadRequestError",
    "NotFoundError",
    "RateLimitError",
    "ReceiptInvalid",
    "error_from_response",
    "parse_retry_after",
]


class AnyrouteError(Exception):
    """Base class. ``status`` is the HTTP status (None for errors that never reached the router)."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        type: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        retry_after: float | None = None,
        response: "httpx.Response | None" = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.type = type
        self.metadata: dict[str, Any] = dict(metadata or {})
        self.retry_after = retry_after
        self.response = response
        self.body = body

    @property
    def code(self) -> int | None:
        """Alias of ``status`` (the router's ``error.code``)."""
        return self.status

    @property
    def request_id(self) -> str | None:
        if self.response is None:
            return None
        return self.response.headers.get("x-generation-id") or self.response.headers.get("x-request-id")

    def __str__(self) -> str:
        parts = [self.message]
        if self.status is not None:
            parts.insert(0, f"[{self.status}{' ' + self.type if self.type else ''}]")
        if self.retry_after is not None:
            parts.append(f"(retry after {self.retry_after:g}s)")
        return " ".join(parts)


class APIError(AnyrouteError):
    """An HTTP error without a more specific class (5xx, 402, 409 and so on)."""


class BadRequestError(AnyrouteError):
    """400 or 422: the request was malformed or failed validation."""


class AuthenticationError(AnyrouteError):
    """401 or 403: the API key is missing, invalid or not allowed to do this."""


class NotFoundError(AnyrouteError):
    """404: no such model, preset, batch or receipt."""


class RateLimitError(AnyrouteError):
    """429. ``retry_after`` holds the seconds the router asked you to wait, when it said."""


class APIConnectionError(AnyrouteError):
    """The request never got an HTTP response (DNS, TLS, connection reset)."""


class APITimeoutError(APIConnectionError):
    """The request timed out."""


class ReceiptInvalid(AnyrouteError):
    """A receipt failed verification. ``result`` is the full ``ReceiptVerification``."""

    def __init__(self, result: "ReceiptVerification") -> None:
        failed = [f"{c.id}: {c.detail}" for c in result.failures] or ["no signature verified"]
        super().__init__("receipt did not verify: " + "; ".join(failed), type="receipt_invalid")
        self.result = result


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """``Retry-After`` as seconds: either delta-seconds or an HTTP-date (never negative). None if absent or unreadable."""
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    try:
        secs = float(v)
        return max(0.0, secs) if secs == secs else None  # reject NaN
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(v)
    except (TypeError, ValueError, IndexError):
        return None
    if dt is None:
        return None
    return max(0.0, dt.timestamp() - (time.time() if now is None else now))


def _class_for(status: int) -> type[AnyrouteError]:
    if status in (400, 422):
        return BadRequestError
    if status in (401, 403):
        return AuthenticationError
    if status == 404:
        return NotFoundError
    if status == 429:
        return RateLimitError
    return APIError


def error_from_body(status: int, body: Any, *, headers: Mapping[str, str] | None = None, response: "httpx.Response | None" = None) -> AnyrouteError:
    err = body.get("error") if isinstance(body, Mapping) else None
    if isinstance(err, Mapping):
        message = str(err.get("message") or f"HTTP {status}")
        etype = err.get("type") if isinstance(err.get("type"), str) else None
        metadata = err.get("metadata") if isinstance(err.get("metadata"), Mapping) else None
        code = err.get("code")
        if isinstance(code, int) and not isinstance(code, bool) and 100 <= code <= 599 and status < 400:
            status = code  # an error event inside a stream carries its status in the body
    else:
        message = body if isinstance(body, str) and body else f"HTTP {status}"
        etype, metadata = None, None
    retry_after = parse_retry_after((headers or {}).get("retry-after"))
    if retry_after is None and metadata and isinstance(metadata.get("retry_after"), (int, float)):
        retry_after = float(metadata["retry_after"])
    return _class_for(status)(message, status=status, type=etype, metadata=metadata, retry_after=retry_after, response=response, body=body)


def error_from_response(response: "httpx.Response") -> AnyrouteError:
    """Build the error for a non-2xx response whose body has been read."""
    try:
        body: Any = response.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        body = response.text[:2000]
    return error_from_body(response.status_code, body, headers=response.headers, response=response)
