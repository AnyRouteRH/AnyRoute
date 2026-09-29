"""Receipt verification: an Ed25519 signature over the payload's canonical JSON, checked against the router's published
keys (or a sidecar's attested key), plus the anchor leaf and, when supplied, the merkle inclusion proof."""

from __future__ import annotations

import base64
import binascii
import hashlib
from datetime import datetime
from typing import Any, Iterable

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .canonical import canonical_bytes
from .keccak import keccak256
from .types import BoundIdentity, Check, ReceiptVerification, failed, passed, skipped

RECEIPT_KEYS_PATH = "/.well-known/anyroute-receipt-keys.json"

NOT_CHECKED_RECEIPT = [
    "That the signing key is the one registered on chain: compare the key id with ReceiptAnchor, or pin the key yourself.",
    "That the anchor root was posted on chain: an inclusion proof shows the receipt is under a root, not that the root was published.",
]


def key_id_of(raw_public_key: bytes) -> str:
    return hashlib.sha256(raw_public_key).hexdigest()[:16]


def receipt_leaf(canonical: bytes, signature: bytes) -> str:
    return "0x" + keccak256(keccak256(canonical + signature)).hex()


def _hex(value: str) -> bytes:
    return bytes.fromhex(value[2:] if value[:2].lower() == "0x" else value)


def verify_merkle_proof(leaf: str, proof: Iterable[str], root: str) -> bool:
    """Sorted-pair (OpenZeppelin-compatible) inclusion, the scheme the router's anchors use."""
    try:
        h = _hex(leaf)
        for p in proof:
            q = _hex(p)
            a, b = (h, q) if h < q else (q, h)
            h = keccak256(a + b)
        return h == _hex(root)
    except ValueError:
        return False


def _b64(text: str) -> bytes:
    t = text.strip().replace("-", "+").replace("_", "/").rstrip("=")
    return base64.b64decode(t + "=" * (-len(t) % 4), validate=True)


def parse_key_set(obj: Any) -> list[dict[str, Any]]:
    keys = obj.get("keys") if isinstance(obj, dict) else None
    if not isinstance(keys, list):
        raise ValueError("receipt key set has no keys array")
    for k in keys:
        if not isinstance(k, dict) or not isinstance(k.get("x"), str) or not isinstance(k.get("kid"), str):
            raise ValueError("receipt key set contains a malformed key")
    return keys


def fetch_receipt_keys(base_url: str, client: httpx.Client | None = None) -> list[dict[str, Any]]:
    http = client or httpx.Client(timeout=20)
    try:
        res = http.get(base_url.rstrip("/") + RECEIPT_KEYS_PATH, headers={"accept": "application/json"})
        if res.status_code != 200:
            raise RuntimeError(f"GET {RECEIPT_KEYS_PATH} failed with {res.status_code}")
        return parse_key_set(res.json())
    finally:
        if client is None:
            http.close()


def _payload_time_ms(payload: dict[str, Any]) -> float | None:
    ts = payload.get("ts")
    if isinstance(ts, (int, float)) and not isinstance(ts, bool):
        return float(ts)
    issued = payload.get("issued")
    if isinstance(issued, str):
        try:
            return datetime.fromisoformat(issued.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            return None
    return None


def _iso_ms(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def verify_receipt(
    receipt: dict[str, Any],
    *,
    keys: list[dict[str, Any]] | dict[str, Any] | None = None,
    public_key_hex: str | None = None,
    clock_skew_ms: float = 300_000,
) -> ReceiptVerification:
    """Verify a receipt against the router's key set (``keys``) or a raw Ed25519 key (``public_key_hex``)."""
    checks: list[Check] = []
    key_id = receipt.get("key_id") if isinstance(receipt, dict) and isinstance(receipt.get("key_id"), str) else ""

    def done(anchor: str) -> ReceiptVerification:
        signature_ok = any(c.id == "signature" and c.status == "pass" for c in checks)
        return ReceiptVerification(all(c.status != "fail" for c in checks) and signature_ok, key_id, checks, anchor, list(NOT_CHECKED_RECEIPT))  # type: ignore[arg-type]

    if not isinstance(receipt, dict) or not isinstance(receipt.get("payload"), dict) or not isinstance(receipt.get("sig"), str) or not key_id:
        checks.append(failed("shape", "A receipt needs payload, sig and key_id."))
        return done("no_proof")
    alg = receipt.get("alg")
    checks.append(passed("alg", "Ed25519") if alg in (None, "Ed25519") else failed("alg", f"unsupported algorithm {alg}"))

    raw: bytes | None = None
    window: tuple[float | None, float | None] | None = None
    if public_key_hex:
        try:
            raw = _hex(public_key_hex)
            if len(raw) != 32:
                raise ValueError
        except ValueError:
            raw = None
            checks.append(failed("key", "The supplied public key is not 32 bytes of hex."))
        if raw is not None:
            derived = key_id_of(raw)
            checks.append(passed("key", f"key id {key_id} matches the supplied key") if derived == key_id else failed("key", f"receipt key id {key_id} is not the supplied key's id ({derived})"))
    else:
        key_list = keys.get("keys", []) if isinstance(keys, dict) else (keys or [])
        jwk = next((k for k in key_list if k.get("kid") == key_id), None)
        if jwk is None:
            checks.append(failed("key", f"Key {key_id} is not in the published key set."))
        elif jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
            checks.append(failed("key", "The published key is not an Ed25519 key."))
        else:
            try:
                raw = _b64(jwk["x"])
                if len(raw) != 32:
                    raise ValueError
                derived = key_id_of(raw)
                checks.append(passed("key", f"key {key_id} is in the published set and its id matches the key bytes") if derived == key_id else failed("key", f"the published key's id does not match its bytes ({derived})"))
                window = (_iso_ms(jwk.get("valid_from")), _iso_ms(jwk.get("retired_at")))
            except (ValueError, binascii.Error):
                raw = None
                checks.append(failed("key", "The published key is malformed."))

    sig: bytes | None = None
    try:
        sig = _b64(receipt["sig"])
    except (ValueError, binascii.Error):
        checks.append(failed("signature", "The signature is not valid base64."))
    canonical = canonical_bytes(receipt["payload"])
    if raw is not None and sig is not None and not any(c.id == "key" and c.status == "fail" for c in checks):
        try:
            Ed25519PublicKey.from_public_bytes(raw).verify(sig, canonical)
            checks.append(passed("signature", "Ed25519 signature over the canonical payload verifies"))
        except InvalidSignature:
            checks.append(failed("signature", "The signature does not verify for this payload and key."))
    elif not any(c.id == "signature" for c in checks):
        checks.append(failed("signature", "Not verified: there is no usable key or signature."))

    t = _payload_time_ms(receipt["payload"])
    if window is not None and t is not None and (window[0] is not None or window[1] is not None):
        early = window[0] is not None and t < window[0] - clock_skew_ms
        late = window[1] is not None and t > window[1] + clock_skew_ms
        checks.append(failed("key_window", "The receipt is dated outside its signing key's validity window.") if early or late else passed("key_window", "The receipt time falls inside its key's validity window"))
    else:
        checks.append(skipped("key_window", "No key window or receipt time to compare."))

    leaf = receipt.get("leaf")
    if isinstance(leaf, str) and leaf and sig is not None:
        checks.append(passed("leaf", "leaf = keccak256(keccak256(payload || signature)) matches") if receipt_leaf(canonical, sig) == leaf.lower() else failed("leaf", "The leaf does not match the payload and signature."))
    else:
        checks.append(skipped("leaf", "The receipt carries no leaf."))

    anchor = "no_proof"
    proof = receipt.get("anchor")
    if isinstance(proof, dict) and isinstance(proof.get("proof"), list) and isinstance(proof.get("root"), str) and isinstance(leaf, str) and leaf:
        ok = verify_merkle_proof(leaf, proof["proof"], proof["root"])
        anchor = "proof_valid" if ok else "proof_invalid"
        checks.append(passed("anchor_proof", f"leaf is included under root {proof['root'][:10]}…") if ok else failed("anchor_proof", "The inclusion proof does not lead from the leaf to the stated root."))
    else:
        checks.append(skipped("anchor_proof", "No anchor proof supplied (a receipt is anchored within the hour; fetch it again later)."))
    return done(anchor)


def verify_sidecar_receipt(receipt: dict[str, Any], bound: BoundIdentity) -> ReceiptVerification:
    """A receipt signed by a provider's sidecar: it must verify under the attested receipt key and name the same
    attestation and model digest. Only meaningful when ``bound`` came from a verification that was ok."""
    base = verify_receipt(receipt, public_key_hex=bound.receipt_pubkey)
    p = receipt.get("payload", {}) if isinstance(receipt, dict) else {}
    extra = [
        passed("sidecar.type", "a sidecar receipt") if p.get("type") == "anyroute.sidecar.receipt" else failed("sidecar.type", "The payload is not a sidecar receipt."),
        passed("sidecar.not_dev", "not marked as simulated") if p.get("dev") is False else failed("sidecar.not_dev", "The receipt is marked as simulated, or does not say."),
        passed("sidecar.attestation_ref", "names the attestation this client verified") if p.get("attestation_ref") == bound.attestation_ref else failed("sidecar.attestation_ref", "The receipt names a different attestation than the one verified."),
        passed("sidecar.model_digest", "names the model digest the quote commits to") if isinstance(p.get("model_digest"), str) and p["model_digest"].lower() == bound.model_digest else failed("sidecar.model_digest", "The receipt names a different model digest than the quote commits to."),
    ]
    base.checks = [*base.checks, *extra]
    base.valid = base.valid and all(c.status == "pass" for c in extra)
    return base
