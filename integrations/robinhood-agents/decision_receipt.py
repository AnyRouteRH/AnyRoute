"""Decision receipts: tag each model call with the SHA-256 of the order intent it informs, so you can later prove which
model said what before a trade. Works with any OpenAI-compatible client that can set a request header.

This file only hashes a JSON object you pass it and checks signatures. It never places orders, never talks to a
brokerage and never sees brokerage credentials. Python 3.9+; signature checks need `pip install cryptography`.

    from openai import OpenAI
    from decision_receipt import decision_headers, verify_decision_receipt

    client = OpenAI(base_url="https://anyroute.tech/api/v1", api_key=os.environ["ANYROUTE_KEY"])
    intent = {"symbol": "STOCK_A", "side": "buy", "quantity": "2", "limit_price": "180.00", "client_order_id": "7f3c"}
    reply = client.chat.completions.create(model=model, messages=messages, extra_headers=decision_headers(intent))
    receipt = reply.model_extra["receipt"]  # keep it next to the intent
    # later, or in an audit:
    check = verify_decision_receipt(receipt, intent, base_url="https://anyroute.tech")
"""
from __future__ import annotations

import base64
import hashlib
import json
import urllib.request
from typing import Any, Optional

DECISION_TAG_HEADER = "X-Anyroute-Decision-Tag"


def canonical_json(value: Any) -> str:
    """Deterministic JSON: keys sorted, no whitespace. Matches the router's form for ASCII keys, strings and integers."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def order_intent_hash(intent: dict) -> str:
    """sha256:<hex> of the canonical JSON of an order intent. Write prices and quantities as strings."""
    return "sha256:" + hashlib.sha256(canonical_json(intent).encode("utf-8")).hexdigest()


def decision_headers(intent: dict) -> dict:
    """The header to send with the model call that informs this intent (OpenAI SDK: extra_headers=...)."""
    return {DECISION_TAG_HEADER: order_intent_hash(intent)}


def _b64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_decision_receipt(receipt: dict, intent: dict, base_url: str = "https://anyroute.tech", keys: Optional[dict] = None) -> dict:
    """Check the router's Ed25519 signature over the receipt payload and that its decision_tag is this intent's hash."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey  # pip install cryptography
    from cryptography.exceptions import InvalidSignature

    expected = order_intent_hash(intent)
    if keys is None:
        with urllib.request.urlopen(base_url.rstrip("/") + "/.well-known/anyroute-receipt-keys.json", timeout=15) as r:
            keys = json.load(r)
    jwk = next((k for k in keys["keys"] if k["kid"] == receipt["key_id"]), None)
    signature = False
    if jwk is not None:
        try:
            Ed25519PublicKey.from_public_bytes(_b64url(jwk["x"])).verify(base64.b64decode(receipt["sig"]), canonical_json(receipt["payload"]).encode("utf-8"))
            signature = True
        except InvalidSignature:
            signature = False
    payload = receipt["payload"]
    tag = payload.get("decision_tag") == expected
    return {
        "ok": signature and tag,
        "checks": {"key_found": jwk is not None, "signature": signature, "decision_tag": tag},
        "expected_tag": expected,
        "model": payload.get("model"),
        "provider": payload.get("provider"),
        "issued": payload.get("issued"),
        "request_sha256": payload.get("request_sha256"),
        "response_sha256": payload.get("response_sha256"),
    }


if __name__ == "__main__":
    # The known vector shared with decision-receipt.ts and the README.
    example = {"symbol": "STOCK_A", "side": "buy", "quantity": "2", "limit_price": "180.00", "client_order_id": "7f3c"}
    print(order_intent_hash(example))
