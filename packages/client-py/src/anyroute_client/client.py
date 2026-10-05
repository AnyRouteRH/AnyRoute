"""An OpenAI-compatible chat call to an Anyroute router, with receipts verified and, for attested providers, the
provider verified before anything is sent."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .attestation import fetch_router_attestation, verify_provider
from .errors import AnyRouteError, AttestationRefused, ReceiptInvalid
from .agent import AgentClient
from .playbooks import PlaybookClient
from .agent_errors import request_error
from .receipts import fetch_receipt_keys, verify_receipt
from .types import ExpectedDigests, ProviderVerification, ReceiptVerification

_DISCLOSURE_RANK = {"any": 0, "policy": 1, "none": 2}
_LANE_RANK = {"public": 0, "attested": 1, "unlinkable": 2}


def _stricter(rank: dict[str, int], existing: Any, wanted: str | None) -> str | None:
    known = isinstance(existing, str) and existing in rank
    if wanted is None:
        return existing if known else None
    return existing if known and rank[existing] > rank[wanted] else wanted


def routing_headers(disclosure: str | None = None, lane: str | None = None) -> dict[str, str]:
    return {**({"x-anyroute-disclosure-max": disclosure} if disclosure else {}), **({"x-anyroute-lane": lane} if lane else {})}


def with_routing(body: dict[str, Any], *, disclosure: str | None = None, lane: str | None = None, only: list[str] | None = None, allow_fallbacks: bool | None = None) -> dict[str, Any]:
    """Merge routing options into ``body["provider"]`` without loosening what the caller already set. The unlinkable
    lane is passed through unchanged; the router refuses it."""
    provider = dict(body.get("provider") or {})
    d = _stricter(_DISCLOSURE_RANK, provider.get("disclosure"), disclosure)
    ln = _stricter(_LANE_RANK, provider.get("lane"), lane)
    if d:
        provider["disclosure"] = d
    if ln:
        provider["lane"] = ln
    if only is not None:
        provider["only"] = only
    if allow_fallbacks is not None:
        provider["allow_fallbacks"] = allow_fallbacks
    return {**body, "provider": provider} if provider else body


@dataclass
class AttestedOptions:
    provider_id: str
    attest_url: str
    expected: ExpectedDigests | None = None
    fresh_nonce: bool = True
    allow_simulated: bool = False
    require_certificate: bool = False
    max_attestation_age_ms: float = 3_600_000
    certificate: bytes | str | None = None
    quote_verifier: Any = None
    cache_seconds: float = 60
    attest_http: httpx.Client | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class AnyRoute:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        private_token: str | None = None,
        http: httpx.Client | None = None,
        headers: dict[str, str] | None = None,
        disclosure: str | None = None,
        lane: str | None = None,
        verify_receipts: bool = True,
        strict_receipts: bool = False,
        receipt_keys: list[dict[str, Any]] | None = None,
        now_ms: Any = None,
    ) -> None:
        if not base_url:
            raise AnyRouteError("base_url is required", "bad_options")
        self.base_url = base_url.rstrip("/")
        self._own_http = http is None
        self._http = http or httpx.Client(timeout=60)
        self._api_key = api_key
        self._private_token = private_token
        self._headers = headers or {}
        self._disclosure = disclosure
        self._lane = lane
        self._verify_receipts = verify_receipts
        self._strict = strict_receipts
        self._pinned = receipt_keys
        self._keys = receipt_keys
        self._now_ms = now_ms
        self.agent = AgentClient(self.base_url, self._http, lambda: {**self._headers, **self._auth()})
        self.playbooks = PlaybookClient(self.base_url, self._http, lambda: {**self._headers, **self._auth()})
        self._verified: dict[str, tuple[float, ProviderVerification]] = {}

    def close(self) -> None:
        if self._own_http:
            self._http.close()

    def __enter__(self) -> "AnyRoute":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def with_private_token(self, token: str) -> "AnyRoute":
        """A copy that authenticates with a blind token instead of an API key."""
        return AnyRoute(self.base_url, None, private_token=token, http=self._http, headers=self._headers, disclosure=self._disclosure, lane=self._lane, verify_receipts=self._verify_receipts, strict_receipts=self._strict, receipt_keys=self._pinned, now_ms=self._now_ms)

    def _auth(self) -> dict[str, str]:
        if self._private_token:
            return {"authorization": f"PrivateToken token={self._private_token}"}
        return {"authorization": f"Bearer {self._api_key}"} if self._api_key else {}

    # ---- receipts -------------------------------------------------------------------------------------------------

    def receipt_keys(self, refresh: bool = False) -> list[dict[str, Any]]:
        if self._pinned is not None:
            return self._pinned
        if self._keys is None or refresh:
            self._keys = fetch_receipt_keys(self.base_url, self._http)
        return self._keys

    def verify_receipt(self, receipt: dict[str, Any]) -> ReceiptVerification:
        """Verify against the router's keys, re-reading the key set once when the key id is unknown (rotation)."""
        keys = self.receipt_keys()
        if self._pinned is None and not any(k.get("kid") == receipt.get("key_id") for k in keys):
            keys = self.receipt_keys(refresh=True)
        return verify_receipt(receipt, keys=keys)

    def get_receipt(self, receipt_id: str) -> dict[str, Any]:
        res = self._http.get(f"{self.base_url}/api/v1/receipts/{receipt_id}", headers={"accept": "application/json"})
        if res.status_code != 200:
            raise AnyRouteError(f"receipt lookup failed with {res.status_code}", "receipt_lookup_failed", res.status_code)
        return res.json()["data"]

    # ---- attestation ----------------------------------------------------------------------------------------------

    def attestation(self, provider_id: str) -> dict[str, Any] | None:
        return fetch_router_attestation(self.base_url, provider_id, self._http)

    def verify_provider(self, opts: AttestedOptions) -> ProviderVerification:
        """Check a provider now (no caching). Never raises for a bad provider: read ``.ok`` and ``.checks``."""
        return verify_provider(
            router_url=self.base_url,
            provider_id=opts.provider_id,
            attest_url=opts.attest_url,
            http=self._http,
            attest_http=opts.attest_http,
            fresh_nonce=opts.fresh_nonce,
            certificate=opts.certificate,
            expected=opts.expected,
            allow_simulated=opts.allow_simulated,
            require_certificate=opts.require_certificate,
            max_attestation_age_ms=opts.max_attestation_age_ms,
            quote_verifier=opts.quote_verifier,
            now_ms=self._now_ms() if self._now_ms else None,
            **opts.extra,
        )

    def _clock(self) -> float:
        return self._now_ms() / 1000 if self._now_ms else time.time()

    def _attest(self, opts: AttestedOptions) -> ProviderVerification:
        key = f"{opts.provider_id}|{opts.attest_url}"
        hit = self._verified.get(key)
        if hit and opts.cache_seconds > 0 and self._clock() - hit[0] < opts.cache_seconds:
            return hit[1]
        v = self.verify_provider(opts)
        if not v.ok:
            self._verified.pop(key, None)
            raise AttestationRefused(v)
        self._verified[key] = (self._clock(), v)
        return v

    # ---- chat -----------------------------------------------------------------------------------------------------

    def chat(
        self,
        body: dict[str, Any],
        *,
        disclosure: str | None = None,
        lane: str | None = None,
        attested: AttestedOptions | None = None,
        headers: dict[str, str] | None = None,
        verify_receipt_on_response: bool | None = None,
    ) -> dict[str, Any]:
        """POST /api/v1/chat/completions. The result is the completion plus an ``anyroute`` object holding the receipt,
        its verification and, when ``attested`` was given, the provider verification that ran before the request."""
        if body.get("stream"):
            raise AnyRouteError("Streaming is not supported by the Python client.", "bad_options")
        d = disclosure or self._disclosure
        ln = lane or self._lane
        routed = with_routing(body, disclosure=d, lane=ln)
        extra = routing_headers(d, ln)
        provider: ProviderVerification | None = None
        if attested is not None:
            provider = self._attest(attested)  # nothing has been sent yet
            routed = with_routing(routed, disclosure="none", lane="attested", only=[attested.provider_id], allow_fallbacks=False)
            extra = {**extra, **routing_headers("none", "attested")}
        res = self._http.post(f"{self.base_url}/api/v1/chat/completions", json=routed, headers={"content-type": "application/json", **self._headers, **self._auth(), **extra, **(headers or {})})
        try:
            data = res.json()
        except ValueError:
            data = None
        if res.status_code != 200 or not isinstance(data, dict):
            err = (data or {}).get("error", {}) if isinstance(data, dict) else {}
            raise request_error(err.get("message") or f"chat request failed with {res.status_code}", err.get("type") or "request_failed", res.status_code, err.get("metadata"))
        receipt = data.get("receipt")
        verification: ReceiptVerification | None = None
        if receipt and (verify_receipt_on_response if verify_receipt_on_response is not None else self._verify_receipts):
            verification = self.verify_receipt(receipt)
            if not verification.valid and self._strict:
                raise ReceiptInvalid(verification)
        data["anyroute"] = {
            "generation_id": res.headers.get("x-generation-id"),
            "disclosure": res.headers.get("x-anyroute-disclosure"),
            "lane": res.headers.get("x-anyroute-lane"),
            "receipt": receipt,
            "receipt_verification": verification,
            "provider": provider,
            "served_by_verified_provider": (receipt.get("payload", {}).get("provider") == provider.provider_id) if provider and receipt else None,
        }
        return data
