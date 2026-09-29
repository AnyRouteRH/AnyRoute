from __future__ import annotations

import hashlib

import pytest

from anyroute_client import canonical_bytes, canonical_json, keccak256, parse_tdx_quote
from anyroute_client.canonical import js_number

from .conftest import Real, load_json


def test_canonical_json_matches_the_javascript_vectors():
    # Expected strings were produced by the router's own canonicalJson (src/lib/util.ts) from the same input text.
    import json

    for case in load_json("canonical-vectors.json"):
        assert canonical_json(json.loads(case["input"])) == case["expected"], case["input"]


def test_key_order_is_by_utf16_code_unit_not_code_point():
    # U+FFFF sorts before the surrogate pair of U+1F600 in JavaScript, after it by Python code point order.
    assert canonical_json({"\U0001f600": 1, "￿": 2}) == '{"\U0001f600":1,"￿":2}'


def test_numbers_are_formatted_like_javascript():
    assert [js_number(x) for x in (1e21, 1e20, 1e-7, 1e-6, 100.0, 0.1, 5e-324, -2.5e-10)] == ["1e+21", "100000000000000000000", "1e-7", "0.000001", "100", "0.1", "5e-324", "-2.5e-10"]
    assert canonical_json({"a": 2**60}) == '{"a":1152921504606847000}'  # beyond 2**53 a JS number is a double
    assert canonical_json({"a": 2**53 + 1}) == '{"a":9007199254740992}'


def test_unsupported_types_are_refused():
    with pytest.raises(TypeError):
        canonical_json({"a": object()})


def test_keccak256_known_answers_are_not_sha3():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    assert keccak256(b"a" * 200).hex() == "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d"
    assert keccak256(b"abc") != hashlib.sha3_256(b"abc").digest()


def test_canonical_bindings_digest_is_what_the_sidecar_committed():
    boot = Real.boot()
    assert hashlib.sha256(canonical_bytes(boot["bindings"])).hexdigest() == boot["report_data"]["bindings_digest"]


def test_quote_fields_match_the_document():
    boot = Real.boot()
    f = parse_tdx_quote(bytes.fromhex(Real.quote_hex()))
    assert (f.version, f.tee_type) == (4, 0x81)
    assert f.mrtd == boot["evidence"]["measurements"]["mrtd"]
    assert f.rtmr3 == boot["evidence"]["measurements"]["rtmr3"]
    assert f.report_data == boot["evidence"]["report_data"]
    assert boot["evidence"]["quote"] == Real.quote_hex()


def test_quote_reader_rejects_short_or_foreign_quotes():
    with pytest.raises(ValueError, match="too short"):
        parse_tdx_quote(b"\x00" * 100)
    q = bytearray(bytes.fromhex(Real.quote_hex()))
    q[0] = 3
    with pytest.raises(ValueError, match="version"):
        parse_tdx_quote(bytes(q))
