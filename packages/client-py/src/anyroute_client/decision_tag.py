"""Decision tags: send the SHA-256 of an order intent with the model call that informs it.

The router signs that hash into the call's v1 receipt (``payload.decision_tag``) and v2 claims (``claims.decision_tag``),
so anyone holding the order and the receipt can later show this model call was made for this order. The router only ever
sees the hash. It records tags only while DECISION_TAGS_ENABLED is on (``GET /api/v1/status``: ``decision_tags.enabled``);
while it is off the header is ignored, so check the first receipt you store.

The hash is SHA-256 of the order's canonical JSON, byte-for-byte what the TypeScript SDK and the router's helpers compute.
Write prices and quantities as strings so every language hashes the same bytes.

    from anyroute_client import AnyRoute, check_decision_tag, with_decision_tag

    order = {"symbol": "STOCK_A", "side": "buy", "quantity": "2", "limit_price": "180.00", "client_order_id": "7f3c"}
    res = client.chat(body, headers=with_decision_tag(order))          # OpenAI SDK: extra_headers=with_decision_tag(order)
    assert check_decision_tag(res["receipt"], order)["matches"]
"""

from __future__ import annotations

import hashlib
from typing import Any, Mapping

from .canonical import canonical_bytes

DECISION_TAG_HEADER = "X-Anyroute-Decision-Tag"


def decision_tag(order: Mapping[str, Any]) -> str:
    """``sha256:<hex>`` of the order's canonical JSON: the decision tag, and Agent Guard's ``details_sha256``."""
    return "sha256:" + hashlib.sha256(canonical_bytes(dict(order))).hexdigest()


def with_decision_tag(order: Mapping[str, Any], headers: Mapping[str, str] | None = None) -> dict[str, str]:
    """``headers`` with this order's decision tag added. Pass it as ``headers=`` to ``AnyRoute.chat`` or as
    ``extra_headers=`` to the OpenAI SDK."""
    return {**(headers or {}), DECISION_TAG_HEADER: decision_tag(order)}


def receipt_decision_tag(receipt: Mapping[str, Any] | None) -> str | None:
    """The decision tag a receipt carries (its v1 payload, else its v2 claims), or None."""
    if not receipt:
        return None
    for holder in (receipt.get("payload"), (receipt.get("v2") or {}).get("claims"), receipt.get("claims")):
        tag = holder.get("decision_tag") if isinstance(holder, Mapping) else None
        if isinstance(tag, str):
            return tag
    return None


def check_decision_tag(receipt: Mapping[str, Any] | None, order: Mapping[str, Any]) -> dict[str, Any]:
    """Whether a receipt's decision tag is this order's hash. It compares hashes only: verify the receipt's signature
    with ``verify_receipt`` (or ``AnyRoute.verify_receipt``) as well."""
    expected = decision_tag(order)
    tag = receipt_decision_tag(receipt)
    return {"matches": tag == expected, "tag": tag, "expected": expected}
