from __future__ import annotations

import base64
import copy
import json

import pytest

from anyroute import Anyroute, ReceiptInvalid
from anyroute._canonical import canonical_json
from anyroute._cbor import CborError, CborTag, loads
from anyroute.receipts import (
    ChainedEvent,
    check_chain,
    chunk_chain,
    decode_receipt_v2,
    key_id_of,
    receipt_leaf_v2,
    sig_structure,
    verify_merkle_proof,
    verify_receipt,
    verify_receipt_v1,
    verify_receipt_v2,
)

from .conftest import FIXTURES, KID, PUB_HEX, RID, SIBLING, V2, FakeRouter, b64url, make_receipt, merkle_root, sign_v1, v1_payload

KEYSET = {"keys": [{"kty": "OKP", "crv": "Ed25519", "x": b64url(bytes.fromhex(PUB_HEX)), "kid": KID, "valid_from": "2025-01-01T00:00:00Z", "retired_at": None}]}


# ---- primitives ----------------------------------------------------------------------------------------------------


def test_canonical_vectors() -> None:
    for case in json.loads((FIXTURES / "canonical-vectors.json").read_text()):
        assert canonical_json(json.loads(case["input"])) == case["expected"], case["input"]


def test_key_id() -> None:
    assert key_id_of(bytes.fromhex(PUB_HEX)) == KID == "21fe31dfa154a261"


def test_cbor_decoder() -> None:
    assert loads(bytes.fromhex("83010203")) == [1, 2, 3]
    assert loads(bytes.fromhex("a26161016162820203")) == {"a": 1, "b": [2, 3]}
    assert loads(bytes.fromhex("3903e7")) == -1000
    assert loads(bytes.fromhex("f4f5f6")[:1]) is False
    assert loads(bytes.fromhex("f93c00")) == 1.0
    assert loads(bytes.fromhex("d24100")) == CborTag(18, b"\x00")
    for bad in ("9f0102ff", "5f4101ff", "8301", "0101", "f7"):
        with pytest.raises(CborError):
            loads(bytes.fromhex(bad))


# ---- v1 ------------------------------------------------------------------------------------------------------------


def test_v1_signed_receipt_verifies_with_keys_and_with_pinned_key() -> None:
    r = sign_v1(v1_payload())
    for result in (verify_receipt_v1(r, KEYSET), verify_receipt_v1(r, KEYSET["keys"]), verify_receipt_v1(r, PUB_HEX), verify_receipt_v1(r, public_key_hex=PUB_HEX)):
        assert result.valid, result.checks
        assert result.key_id == KID and result.version == 1
        assert result.status("signature") == "pass" and result.status("leaf") == "pass"
    assert verify_receipt_v1(r, KEYSET).status("key_window") == "pass"
    assert verify_receipt_v1(r, PUB_HEX).status("key_window") == "not_checked"  # a pinned key has no window


def test_v1_tampering_fails() -> None:
    r = sign_v1(v1_payload())
    t = copy.deepcopy(r)
    t["payload"]["cost"] = 0.0001
    res = verify_receipt_v1(t, KEYSET)
    assert not res.valid and res.status("signature") == "fail" and res.status("leaf") == "fail"
    wrong_kid = dict(r, key_id="0000000000000000")
    assert verify_receipt_v1(wrong_kid, KEYSET).status("key") == "fail"
    assert not verify_receipt_v1(r, "11" * 32).valid
    assert not verify_receipt_v1(r).valid  # no keys at all
    assert verify_receipt_v1({"sig": "x"}, KEYSET).status("shape") == "fail"


def test_v1_key_window() -> None:
    r = sign_v1(v1_payload())
    retired = {"keys": [dict(KEYSET["keys"][0], retired_at="2025-06-01T00:00:00Z")]}
    res = verify_receipt_v1(r, retired)
    assert not res.valid and res.status("key_window") == "fail"


def test_v1_anchor_proof() -> None:
    r = sign_v1(v1_payload())
    root = merkle_root(r["leaf"], SIBLING)
    ok = verify_receipt_v1(r, KEYSET, proof={"root": root, "proof": [SIBLING]})
    assert ok.valid and ok.anchor == "proof_valid"
    r["anchor"] = {"root": "0x" + "00" * 32, "proof": [SIBLING]}
    bad = verify_receipt_v1(r, KEYSET)
    assert not bad.valid and bad.anchor == "proof_invalid"


# ---- v2 ------------------------------------------------------------------------------------------------------------


def test_v2_fixture_decodes() -> None:
    d = decode_receipt_v2(V2["cose"])
    assert d.alg == -8 and d.key_id == KID
    assert d.claims == V2["claims"]
    assert receipt_leaf_v2(base64.b64decode(V2["cose"])) == V2["leaf"]
    assert sig_structure(d.protected, d.payload)[:12] == bytes.fromhex("846a") + b"Signature1"


def test_v2_fixture_verifies() -> None:
    for result in (verify_receipt_v2(V2["cose"], KEYSET), verify_receipt_v2(base64.b64decode(V2["cose"]), public_key_hex=PUB_HEX)):
        assert result.valid, result.checks
        assert result.key_id == KID and result.leaf == V2["leaf"] and result.claims == V2["claims"]
    full = verify_receipt_v2(V2["cose"], KEYSET, chunks=V2["chunks"], response_sha256=V2["claims"]["resp"]["h"], request_sha256="1" * 64, leaf=V2["leaf"])
    assert full.valid and full.status("chain") == "pass" and full.status("hashes") == "pass" and full.status("leaf") == "pass"


def test_v2_tampered_fails() -> None:
    raw = bytearray(base64.b64decode(V2["cose"]))
    sig_flip = bytearray(raw)
    sig_flip[-1] ^= 0x01
    res = verify_receipt_v2(bytes(sig_flip), KEYSET)
    assert not res.valid and res.status("signature") == "fail"

    # change one claim character ("prepaid" -> "prepaie") keeping the CBOR well formed
    i = raw.find(b"prepaid")
    claim_flip = bytearray(raw)
    claim_flip[i + 6] = ord("e")
    res2 = verify_receipt_v2(bytes(claim_flip), KEYSET)
    assert not res2.valid and res2.status("signature") == "fail"
    assert res2.claims is not None and res2.claims["credit"]["mode"] == "prepaie"

    assert not verify_receipt_v2(V2["cose"], KEYSET, chunks=V2["chunks"][:2]).valid  # a cut stream
    assert verify_receipt_v2(V2["cose"], KEYSET, response_sha256="00" * 32).status("hashes") == "fail"
    assert verify_receipt_v2(V2["cose"], KEYSET, leaf="0x" + "00" * 32).status("leaf") == "fail"
    assert verify_receipt_v2(b"\x00garbage", KEYSET).status("shape") == "fail"
    assert not verify_receipt_v2(V2["cose"], "22" * 32).valid


def test_v2_anchor_proof() -> None:
    root = merkle_root(V2["leaf"], SIBLING)
    assert verify_merkle_proof(V2["leaf"], [SIBLING], root)
    assert not verify_merkle_proof(V2["leaf"], [SIBLING], "0x" + "00" * 32)
    assert verify_receipt_v2(V2["cose"], KEYSET, proof={"root": root, "proof": [SIBLING]}).anchor == "proof_valid"


# ---- chain ---------------------------------------------------------------------------------------------------------


def test_chain_steps_match_fixture() -> None:
    cs = chunk_chain(RID, V2["chunks"])
    assert cs.steps == V2["chain_steps"] and cs.head == V2["claims"]["resp"]["chain"]
    events = [ChainedEvent(d, c) for d, c in zip(V2["chunks"], V2["chain_steps"])]
    assert check_chain(RID, events, signed_head=cs.head).ok
    assert check_chain(RID, list(zip(V2["chunks"], V2["chain_steps"]))).ok
    swapped = [events[1], events[0], events[2]]
    bad = check_chain(RID, swapped)
    assert not bad.ok and bad.first_mismatch == 1
    missing = [events[0], ChainedEvent(events[1].data, None), events[2]]
    assert check_chain(RID, missing).first_mismatch == 2
    assert not check_chain(RID, events, signed_head="sha256:" + "0" * 64).ok


# ---- both, and the client's resource -------------------------------------------------------------------------------


def test_verify_receipt_auto_picks_formats() -> None:
    both = verify_receipt(make_receipt(), KEYSET)
    assert both.valid and both.v1 and both.v2 and both.status("v1.signature") == "pass" and both.status("v2.signature") == "pass"
    only_v1 = verify_receipt(make_receipt(v2=False), KEYSET)
    assert only_v1.valid and only_v1.v2 is None
    only_v2 = verify_receipt(make_receipt()["v2"], KEYSET)
    assert only_v2.valid and only_v2.v1 is None
    assert verify_receipt(V2["cose"], KEYSET).valid
    assert not verify_receipt({"id": "x"}, KEYSET).valid
    r = make_receipt()
    r["id"] = "gen-other"
    mismatch = verify_receipt(r, KEYSET)
    assert not mismatch.valid and mismatch.status("rid") == "fail"
    r2 = make_receipt()
    r2["v2"] = dict(r2["v2"], cose=base64.b64encode(bytes(base64.b64decode(V2["cose"])[:-1]) + b"\x00").decode())
    assert not verify_receipt(r2, KEYSET).valid
    with pytest.raises(ReceiptInvalid) as e:
        verify_receipt(r2, KEYSET).raise_if_invalid()
    assert e.value.result.v2 is not None and "signature" in str(e.value)


def test_receipts_resource(client: Anyroute) -> None:
    keys = client.receipts.keys()
    assert keys[0]["kid"] == KID
    stored = client.receipts.get(RID)
    assert stored.version == 2 and stored.v2["kid"] == KID
    proof = client.receipts.proof(RID)
    assert proof.leaf_version == 2 and proof.proof == [SIBLING]
    result = client.receipts.verify(stored, proof=proof)
    assert result.valid and result.v2 is not None and result.v2.anchor == "proof_valid"
    assert result.v1 is not None and result.v1.anchor == "no_proof"
    by_id = client.receipts.verify_id(RID)
    assert by_id.valid and by_id.v2.anchor == "proof_valid"
    pinned = client.receipts.verify(stored, public_key_hex=PUB_HEX)
    assert pinned.valid


def test_unknown_key_triggers_one_refetch(client: Anyroute, router: FakeRouter) -> None:
    client._keys.store({"keys": [{"kty": "OKP", "crv": "Ed25519", "x": b64url(b"\x01" * 32), "kid": key_id_of(b"\x01" * 32)}]})
    assert client.receipts.verify(make_receipt()).valid
    assert router.key_fetches == 1
