"""Receipt verification. Pure functions: nothing here touches the network.

Two receipt formats exist and a router response usually carries both:

* v1: an Ed25519 signature over the canonical JSON of ``payload``, with ``key_id`` naming the signing key.
* v2: a COSE_Sign1 (RFC 9052, CBOR tag 18) over a CBOR claim set, signed EdDSA with the same key. A streamed
  response also commits to a hash chain over its events (``claims.resp.chain``).

Keys come from ``GET /.well-known/anyroute-receipt-keys.json`` (``Anyroute.receipts.keys()`` fetches and caches it),
or you can pin a raw 32 byte Ed25519 public key as hex.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, Literal, Mapping, Sequence, Union

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from . import _cbor
from ._canonical import canonical_bytes, canonical_json
from ._keccak import keccak256

__all__ = [
    "COSE_ALG_EDDSA",
    "CHAIN_COMMENT",
    "Check",
    "ChainCheck",
    "ChainSteps",
    "ChainedEvent",
    "DecodedReceiptV2",
    "Keys",
    "ReceiptVerification",
    "VerificationResult",
    "canonical_bytes",
    "canonical_json",
    "check_chain",
    "chunk_chain",
    "decode_receipt_v2",
    "key_id_of",
    "keccak256",
    "parse_key_set",
    "receipt_leaf_v1",
    "receipt_leaf_v2",
    "sig_structure",
    "verify_merkle_proof",
    "verify_receipt",
    "verify_receipt_v1",
    "verify_receipt_v2",
]

COSE_ALG_EDDSA = -8
CHAIN_COMMENT = re.compile(r"^: ?anyroute-chain (\d+) ([0-9a-f]{64})$")

CheckStatus = Literal["pass", "fail", "not_checked"]
AnchorStatus = Literal["proof_valid", "proof_invalid", "no_proof"]
# A key set as published ({"keys": [...]}), the list inside it, or one raw public key as hex.
Keys = Union[Mapping[str, Any], Sequence[Mapping[str, Any]], str, None]


# ---- result types --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    """One line of a verification report. ``not_checked`` is never a pass: it means nothing was compared."""

    id: str
    status: CheckStatus
    detail: str


def _pass(id: str, detail: str) -> Check:
    return Check(id, "pass", detail)


def _fail(id: str, detail: str) -> Check:
    return Check(id, "fail", detail)


def _skip(id: str, detail: str) -> Check:
    return Check(id, "not_checked", detail)


@dataclass
class VerificationResult:
    """The outcome for one receipt format. ``valid`` needs a passing signature and no failed check."""

    valid: bool
    version: int
    key_id: str
    checks: list[Check]
    anchor: AnchorStatus = "no_proof"
    leaf: str | None = None
    claims: dict[str, Any] | None = None

    def status(self, check_id: str) -> str | None:
        return next((c.status for c in self.checks if c.id == check_id), None)

    def __bool__(self) -> bool:
        return self.valid


@dataclass
class ReceiptVerification:
    """What ``verify_receipt`` found: v1 and/or v2 results. ``valid`` is true only if every format present verified."""

    valid: bool
    v1: VerificationResult | None = None
    v2: VerificationResult | None = None
    extra: list[Check] = field(default_factory=list)

    @property
    def checks(self) -> list[Check]:
        out = list(self.extra)
        for r in (self.v1, self.v2):
            if r is not None:
                out += [Check(f"v{r.version}.{c.id}", c.status, c.detail) for c in r.checks]
        return out

    @property
    def key_id(self) -> str:
        return (self.v2.key_id if self.v2 else "") or (self.v1.key_id if self.v1 else "")

    @property
    def failures(self) -> list[Check]:
        return [c for c in self.checks if c.status == "fail"]

    def status(self, check_id: str) -> str | None:
        return next((c.status for c in self.checks if c.id == check_id), None)

    def raise_if_invalid(self) -> "ReceiptVerification":
        if not self.valid:
            from .errors import ReceiptInvalid

            raise ReceiptInvalid(self)
        return self

    def __bool__(self) -> bool:
        return self.valid


# ---- small helpers -------------------------------------------------------------------------------------------------


def key_id_of(raw_public_key: bytes) -> str:
    """The key id: the first 16 hex characters of SHA-256 over the raw 32 byte public key."""
    return hashlib.sha256(raw_public_key).hexdigest()[:16]


def _hex(value: str) -> bytes:
    return bytes.fromhex(value[2:] if value[:2].lower() == "0x" else value)


def _b64(text: str) -> bytes:
    t = text.strip().replace("-", "+").replace("_", "/").rstrip("=")
    return base64.b64decode(t + "=" * (-len(t) % 4), validate=True)


def _bare(h: Any) -> str:
    s = str(h or "").lower()
    return s[7:] if s.startswith("sha256:") else s


def _iso_ms(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def receipt_leaf_v1(canonical: bytes, signature: bytes) -> str:
    """v1 anchor leaf: keccak256(keccak256(canonical payload || signature)), 0x prefixed."""
    return "0x" + keccak256(keccak256(canonical + signature)).hex()


def receipt_leaf_v2(cose: bytes) -> str:
    """v2 anchor leaf: keccak256(keccak256(COSE_Sign1 bytes)), 0x prefixed."""
    return "0x" + keccak256(keccak256(cose)).hex()


def verify_merkle_proof(leaf: str, proof: Iterable[str], root: str) -> bool:
    """Sorted-pair keccak256 inclusion (the OpenZeppelin MerkleProof scheme the router's anchors use)."""
    try:
        h = _hex(leaf)
        for p in proof:
            q = _hex(p)
            a, b = (h, q) if h < q else (q, h)
            h = keccak256(a + b)
        return h == _hex(root)
    except (ValueError, TypeError):
        return False


def parse_key_set(obj: Any) -> list[dict[str, Any]]:
    """Validate a published key set and return its keys."""
    keys = obj.get("keys") if isinstance(obj, Mapping) else obj
    if not isinstance(keys, list):
        raise ValueError("receipt key set has no keys array")
    for k in keys:
        if not isinstance(k, Mapping) or not isinstance(k.get("x"), str) or not isinstance(k.get("kid"), str):
            raise ValueError("receipt key set contains a malformed key")
    return [dict(k) for k in keys]


def _resolve_key(key_id: str, keys: Keys, public_key_hex: str | None) -> tuple[bytes | None, Check, tuple[float | None, float | None] | None]:
    """Find the raw key for ``key_id``. Returns (raw key or None, the key check, the key's validity window)."""
    if isinstance(keys, str) and public_key_hex is None:
        public_key_hex, keys = keys, None
    if public_key_hex:
        try:
            raw = _hex(public_key_hex)
            if len(raw) != 32:
                raise ValueError
        except ValueError:
            return None, _fail("key", "The supplied public key is not 32 bytes of hex."), None
        derived = key_id_of(raw)
        if derived != key_id:
            return raw, _fail("key", f"receipt key id {key_id or '(none)'} is not the supplied key's id ({derived})"), None
        return raw, _pass("key", f"key id {key_id} matches the supplied key"), None
    if keys is None:
        return None, _fail("key", "No keys supplied: pass the published key set or a public key."), None
    key_list = keys.get("keys", []) if isinstance(keys, Mapping) else keys
    jwk = next((k for k in key_list if isinstance(k, Mapping) and k.get("kid") == key_id), None)
    if jwk is None:
        return None, _fail("key", f"Key {key_id or '(none)'} is not in the published key set."), None
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
        return None, _fail("key", "The published key is not an Ed25519 key."), None
    try:
        raw = _b64(str(jwk.get("x", "")))
        if len(raw) != 32:
            raise ValueError
    except (ValueError, binascii.Error):
        return None, _fail("key", "The published key is malformed."), None
    derived = key_id_of(raw)
    if derived != key_id:
        return None, _fail("key", f"the published key's id does not match its bytes ({derived})"), None
    window = (_iso_ms(jwk.get("valid_from")), _iso_ms(jwk.get("retired_at")))
    return raw, _pass("key", f"key {key_id} is in the published set and its id matches the key bytes"), window


def _ed25519_ok(raw: bytes, signature: bytes, message: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(raw).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


def _anchor_check(leaf: str | None, proof: Mapping[str, Any] | None, checks: list[Check]) -> AnchorStatus:
    if leaf and isinstance(proof, Mapping) and isinstance(proof.get("proof"), list) and isinstance(proof.get("root"), str):
        ok = verify_merkle_proof(leaf, proof["proof"], proof["root"])
        off_chain = "" if proof.get("anchored", True) else " (root kept off chain)"
        checks.append(_pass("anchor_proof", f"leaf is under root {proof['root'][:10]}...{off_chain}") if ok else _fail("anchor_proof", "The Merkle path does not lead from this receipt to the root."))
        return "proof_valid" if ok else "proof_invalid"
    checks.append(_skip("anchor_proof", "No inclusion proof supplied (roots are built hourly; fetch the proof later)."))
    return "no_proof"


def _done(version: int, key_id: str, checks: list[Check], anchor: AnchorStatus, leaf: str | None = None, claims: dict[str, Any] | None = None) -> VerificationResult:
    sig_ok = any(c.id == "signature" and c.status == "pass" for c in checks)
    valid = sig_ok and all(c.status != "fail" for c in checks)
    return VerificationResult(valid, version, key_id, checks, anchor, leaf, claims)


# ---- v1 ------------------------------------------------------------------------------------------------------------


def verify_receipt_v1(
    receipt: Mapping[str, Any],
    keys: Keys = None,
    *,
    public_key_hex: str | None = None,
    proof: Mapping[str, Any] | None = None,
    clock_skew_ms: float = 300_000,
) -> VerificationResult:
    """Verify a v1 receipt (``{payload, sig, key_id, leaf?, anchor?}``).

    ``keys`` is the published key set (dict or list) or a public key as hex. ``proof`` is an inclusion proof
    (``{root, proof: [hex]}``, as ``GET /api/v1/receipts/{id}/proof`` returns); ``receipt["anchor"]`` is used if absent.
    """
    checks: list[Check] = []
    key_id = receipt.get("key_id") if isinstance(receipt, Mapping) and isinstance(receipt.get("key_id"), str) else ""
    if not isinstance(receipt, Mapping) or not isinstance(receipt.get("payload"), Mapping) or not isinstance(receipt.get("sig"), str) or not key_id:
        checks.append(_fail("shape", "A v1 receipt needs payload, sig and key_id."))
        return _done(1, key_id or "", checks, "no_proof")
    alg = receipt.get("alg")
    checks.append(_pass("alg", "Ed25519") if alg in (None, "Ed25519") else _fail("alg", f"unsupported algorithm {alg}"))

    raw, key_check, window = _resolve_key(key_id, keys, public_key_hex)
    checks.append(key_check)

    sig: bytes | None = None
    try:
        sig = _b64(receipt["sig"])
    except (ValueError, binascii.Error):
        checks.append(_fail("signature", "The signature is not valid base64."))
    canonical = canonical_bytes(receipt["payload"])
    if raw is not None and sig is not None and key_check.status == "pass":
        ok = _ed25519_ok(raw, sig, canonical)
        checks.append(_pass("signature", "Ed25519 signature over the canonical payload verifies") if ok else _fail("signature", "The signature does not verify for this payload and key."))
    elif sig is not None:
        checks.append(_fail("signature", "Not verified: there is no usable key."))

    payload = receipt["payload"]
    ts = payload.get("ts")
    t = float(ts) if isinstance(ts, (int, float)) and not isinstance(ts, bool) else _iso_ms(payload.get("issued"))
    if window is not None and t is not None and (window[0] is not None or window[1] is not None):
        early = window[0] is not None and t < window[0] - clock_skew_ms
        late = window[1] is not None and t > window[1] + clock_skew_ms
        checks.append(_fail("key_window", "The receipt is dated outside its signing key's validity window.") if early or late else _pass("key_window", "The receipt time falls inside its key's validity window"))
    else:
        checks.append(_skip("key_window", "No key window or receipt time to compare."))

    leaf = receipt.get("leaf")
    computed = receipt_leaf_v1(canonical, sig) if sig is not None else None
    if isinstance(leaf, str) and leaf and computed:
        checks.append(_pass("leaf", "leaf = keccak256(keccak256(payload || signature)) matches") if computed == leaf.lower() else _fail("leaf", "The leaf does not match the payload and signature."))
    else:
        checks.append(_skip("leaf", "The receipt carries no leaf."))

    anchor_src = proof if proof is not None else receipt.get("anchor")
    anchor = _anchor_check(computed, anchor_src if isinstance(anchor_src, Mapping) else None, checks)
    return _done(1, key_id, checks, anchor, computed)


# ---- v2 ------------------------------------------------------------------------------------------------------------


@dataclass
class DecodedReceiptV2:
    alg: int | None
    key_id: str
    claims: dict[str, Any]
    protected: bytes
    payload: bytes
    signature: bytes


def _to_json(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _to_json(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_to_json(x) for x in v]
    if isinstance(v, bytes):
        return v.hex()
    if isinstance(v, _cbor.CborTag):
        return {"tag": v.tag, "value": _to_json(v.value)}
    return v


def _cose_bytes(cose: bytes | bytearray | str) -> bytes:
    return bytes(cose) if isinstance(cose, (bytes, bytearray)) else _b64(cose)


def decode_receipt_v2(cose: bytes | bytearray | str) -> DecodedReceiptV2:
    """Parse COSE_Sign1 bytes (or base64 of them). Raises ``ValueError`` on anything malformed."""
    v = _cbor.loads(_cose_bytes(cose))
    if isinstance(v, _cbor.CborTag):
        if v.tag != 18:
            raise ValueError(f"not a COSE_Sign1 (tag {v.tag})")
        v = v.value
    if not isinstance(v, list) or len(v) != 4:
        raise ValueError("COSE_Sign1 must be an array of four items")
    protected, _unprotected, payload, signature = v
    if not isinstance(protected, bytes) or not isinstance(payload, bytes) or not isinstance(signature, bytes):
        raise ValueError("COSE_Sign1 items have the wrong types")
    hdr = _cbor.loads(protected) if protected else {}
    if not isinstance(hdr, dict):
        raise ValueError("protected header is not a map")
    alg = hdr.get(1)
    kid = hdr.get(4)
    claims = _to_json(_cbor.loads(payload))
    if not isinstance(claims, dict):
        raise ValueError("payload is not a claim map")
    return DecodedReceiptV2(alg if isinstance(alg, int) else None, kid.hex() if isinstance(kid, bytes) else "", claims, protected, payload, signature)


def sig_structure(protected: bytes, payload: bytes) -> bytes:
    """Sig_structure for COSE_Sign1: ["Signature1", protected, external_aad (empty), payload], canonical CBOR."""
    return _cbor.head(4, 4) + _cbor.tstr("Signature1") + _cbor.bstr(protected) + _cbor.bstr(b"") + _cbor.bstr(payload)


def verify_receipt_v2(
    cose: bytes | bytearray | str,
    keys: Keys = None,
    *,
    public_key_hex: str | None = None,
    chunks: Sequence[str] | None = None,
    request_sha256: str | None = None,
    response_sha256: str | None = None,
    proof: Mapping[str, Any] | None = None,
    leaf: str | None = None,
) -> VerificationResult:
    """Verify a v2 receipt (COSE_Sign1 bytes or base64).

    ``chunks`` are the data strings of every streamed event before the receipt: they recompute the chain head.
    ``request_sha256`` / ``response_sha256`` are compared with ``req.h`` / ``resp.h``. ``leaf`` is a leaf the
    envelope claims, compared with the computed one. ``proof`` is an inclusion proof ``{root, proof: [hex]}``.
    """
    checks: list[Check] = []
    try:
        raw_cose = _cose_bytes(cose)
        d = decode_receipt_v2(raw_cose)
    except (ValueError, binascii.Error, TypeError) as e:
        return VerificationResult(False, 2, "", [_fail("shape", f"Not a COSE_Sign1 receipt: {e}")])
    computed = receipt_leaf_v2(raw_cose)
    claims = d.claims
    checks.append(_pass("alg", "EdDSA (COSE -8)") if d.alg == COSE_ALG_EDDSA else _fail("alg", f"unsupported COSE algorithm {d.alg}"))
    checks.append(_pass("claims", f"v2 claims for {claims.get('rid')}") if claims.get("v") == 2 and isinstance(claims.get("rid"), str) else _fail("claims", "The payload is not a v2 claim set."))

    # 1. The signature under the named key.
    raw, key_check, _window = _resolve_key(d.key_id, keys, public_key_hex)
    checks.append(key_check)
    if raw is not None and key_check.status == "pass":
        ok = _ed25519_ok(raw, d.signature, sig_structure(d.protected, d.payload))
        checks.append(_pass("signature", "COSE_Sign1 signature verifies") if ok else _fail("signature", "The COSE signature does not verify for these claims and key."))
    else:
        checks.append(_fail("signature", "Not verified: no usable key."))

    # 2. Hashes the caller holds.
    req = claims.get("req") if isinstance(claims.get("req"), dict) else {}
    resp = claims.get("resp") if isinstance(claims.get("resp"), dict) else {}
    if request_sha256 is not None or response_sha256 is not None:
        req_ok = request_sha256 is None or _bare(request_sha256) == _bare(req.get("h"))
        resp_ok = response_sha256 is None or _bare(response_sha256) == _bare(resp.get("h"))
        bad = " ".join(n for n, ok in (("req.h", req_ok), ("resp.h", resp_ok)) if not ok)
        checks.append(_pass("hashes", "req.h and resp.h match what you hold") if not bad else _fail("hashes", f"{bad} does not match"))
    else:
        checks.append(_skip("hashes", "No request or response hash supplied."))

    # 3. The chain head over the streamed events.
    signed_head = resp.get("chain")
    if chunks is not None:
        head = chunk_chain(str(claims.get("rid", "")), chunks).head
        if not signed_head:
            checks.append(_fail("chain", "The receipt carries no chain head, but stream events were supplied."))
        else:
            checks.append(_pass("chain", f"chain head over {len(chunks)} events matches") if head == signed_head else _fail("chain", "The chain head does not match the events received: the stream was cut or altered."))
    else:
        checks.append(_skip("chain", "Supply the streamed events to check the chain head." if signed_head else "Not a streamed response."))

    # 4. The leaf the envelope states, then the inclusion proof.
    if leaf:
        checks.append(_pass("leaf", "leaf = keccak256(keccak256(COSE bytes)) matches") if leaf.lower() == computed else _fail("leaf", "The stated leaf does not match the COSE bytes."))
    anchor = _anchor_check(computed, proof, checks)
    return _done(2, d.key_id, checks, anchor, computed, claims)


# ---- the streamed chunk chain --------------------------------------------------------------------------------------


@dataclass
class ChainedEvent:
    """A streamed event as received: its exact data text and the chain value the router sent after it."""

    data: str
    chain: str | None = None


@dataclass
class ChainSteps:
    steps: list[str]
    head: str


@dataclass
class ChainCheck:
    """``ok`` means every per-event value matched and (when known) the head equals the head signed in the receipt."""

    ok: bool
    head: str
    first_mismatch: int | None = None
    signed_head: str | None = None
    events: int = 0

    def __bool__(self) -> bool:
        return self.ok


def chunk_chain(rid: str, chunks: Sequence[str]) -> ChainSteps:
    """c0 = SHA-256(rid); c_i = SHA-256(c_{i-1} || data_i). Returns every c_i in hex and the head ("sha256:<hex>")."""
    c = hashlib.sha256(rid.encode("utf-8")).digest()
    steps: list[str] = []
    for d in chunks:
        c = hashlib.sha256(c + d.encode("utf-8")).digest()
        steps.append(c.hex())
    return ChainSteps(steps, "sha256:" + c.hex())


def check_chain(rid: str, events: Sequence[ChainedEvent | tuple[str, str | None]], signed_head: str | None = None) -> ChainCheck:
    """Recompute the chain over what arrived and compare each step with the value the router sent.

    ``first_mismatch`` is the 1-based index of the first event whose value is missing or wrong. With ``signed_head``
    (``receipt.v2.claims.resp.chain``) the head must match it too.
    """
    evs = [e if isinstance(e, ChainedEvent) else ChainedEvent(e[0], e[1]) for e in events]
    cs = chunk_chain(rid, [e.data for e in evs])
    bad = next((i for i, e in enumerate(evs) if e.chain != cs.steps[i]), None)
    ok = bad is None and (signed_head is None or signed_head == cs.head)
    return ChainCheck(ok, cs.head, None if bad is None else bad + 1, signed_head, len(evs))


# ---- both formats --------------------------------------------------------------------------------------------------


def _proof_version(proof: Mapping[str, Any] | None, receipt: Mapping[str, Any]) -> int | None:
    if not isinstance(proof, Mapping):
        return None
    lv = proof.get("leaf_version")
    if lv in (1, 2):
        return int(lv)
    pl = str(proof.get("leaf") or "").lower()
    v2 = receipt.get("v2") if isinstance(receipt.get("v2"), Mapping) else None
    if pl and v2 and str(v2.get("leaf") or "").lower() == pl:
        return 2
    if pl and str(receipt.get("leaf") or "").lower() == pl:
        return 1
    return 2 if v2 else 1


def verify_receipt(
    receipt: Mapping[str, Any] | bytes | str,
    keys: Keys = None,
    *,
    public_key_hex: str | None = None,
    chunks: Sequence[str] | None = None,
    request_sha256: str | None = None,
    response_sha256: str | None = None,
    proof: Mapping[str, Any] | None = None,
) -> ReceiptVerification:
    """Verify whatever a receipt carries: v1 (``payload`` + ``sig``), v2 (``v2.cose``), or both.

    Accepts the ``receipt`` object from a response, the ``data`` of ``GET /api/v1/receipts/{id}``, a bare v2 object
    (``{cose, ...}``), or COSE bytes/base64. Valid only when every format present verifies.
    """
    extra: list[Check] = []
    if isinstance(receipt, (bytes, bytearray, str)):
        v2 = verify_receipt_v2(receipt, keys, public_key_hex=public_key_hex, chunks=chunks, request_sha256=request_sha256, response_sha256=response_sha256, proof=proof)
        return ReceiptVerification(v2.valid, None, v2)
    if not isinstance(receipt, Mapping):
        return ReceiptVerification(False, extra=[_fail("shape", "A receipt must be an object, COSE bytes or base64.")])

    v2_obj = receipt.get("v2") if isinstance(receipt.get("v2"), Mapping) else (receipt if "cose" in receipt else None)
    has_v1 = isinstance(receipt.get("payload"), Mapping) and isinstance(receipt.get("sig"), str)
    pv = _proof_version(proof, receipt)

    r1 = verify_receipt_v1(receipt, keys, public_key_hex=public_key_hex, proof=proof if pv == 1 else None) if has_v1 else None
    r2 = None
    if v2_obj is not None and v2_obj.get("cose"):
        v2_proof = proof if pv == 2 else (v2_obj.get("anchor") if isinstance(v2_obj.get("anchor"), Mapping) else None)
        leaf = v2_obj.get("leaf") if isinstance(v2_obj.get("leaf"), str) else None
        r2 = verify_receipt_v2(v2_obj["cose"], keys, public_key_hex=public_key_hex, chunks=chunks, request_sha256=request_sha256, response_sha256=response_sha256, proof=v2_proof, leaf=leaf)
        rid = receipt.get("id")
        if isinstance(rid, str) and r2.claims is not None:
            extra.append(_pass("rid", f"v2 claims name receipt {rid}") if r2.claims.get("rid") == rid else _fail("rid", f"The v2 claims name {r2.claims.get('rid')}, not {rid}."))
    elif chunks is not None:
        extra.append(_fail("chain", "Stream events were supplied but the receipt has no v2 part to check them against."))

    if r1 is None and r2 is None:
        extra.append(_fail("shape", "The receipt has neither a v1 signature (payload, sig) nor a v2 COSE_Sign1."))
    valid = (r1 is not None or r2 is not None) and all(r.valid for r in (r1, r2) if r is not None) and all(c.status != "fail" for c in extra)
    return ReceiptVerification(valid, r1, r2, extra)
