from __future__ import annotations

import base64

import httpx
import pytest

from anyroute_client import (
    AnyRoute,
    canonical_bytes,
    evaluate_attestation,
    fetch_receipt_keys,
    keccak256,
    parse_key_set,
    receipt_leaf,
    verify_merkle_proof,
    verify_receipt,
    verify_sidecar_receipt,
)

from .conftest import NOW_MS, Real, RouterKey, clone


def bound_key() -> str:
    return Real.boot()["bindings"]["receipt_pubkey"]


class TestRealReceipt:
    def test_verifies_under_the_key_the_quote_commits_to_and_the_leaf_recomputes(self):
        v = verify_receipt(Real.receipt(), public_key_hex=bound_key())
        assert v.valid
        assert (v.status("signature"), v.status("key"), v.status("leaf")) == ("pass", "pass", "pass")
        assert v.anchor == "no_proof"
        assert v.status("anchor_proof") == "not_checked"  # no proof came with it, and the report says so
        assert any("on chain" in n for n in v.not_checked)

    @pytest.mark.parametrize("change", [{"status": 500}, {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}, {"model_digest": "sha256:" + "0" * 64}, {"extra": True}])
    def test_fails_when_any_signed_field_changes(self, change):
        r = Real.receipt()
        r["payload"].update(change)
        v = verify_receipt(r, public_key_hex=bound_key())
        assert not v.valid and v.status("signature") == "fail"

    def test_fails_under_another_key_id_or_signature(self):
        other = RouterKey()
        assert not verify_receipt(Real.receipt(), public_key_hex=base64.urlsafe_b64decode(other.jwk["x"] + "==").hex()).valid
        assert not verify_receipt({**Real.receipt(), "key_id": "0" * 16}, public_key_hex=bound_key()).valid
        sig = bytearray(base64.b64decode(Real.receipt()["sig"]))
        sig[3] ^= 1
        assert not verify_receipt({**Real.receipt(), "sig": base64.b64encode(bytes(sig)).decode()}, public_key_hex=bound_key()).valid
        assert not verify_receipt({**Real.receipt(), "leaf": "0x" + "11" * 32}, public_key_hex=bound_key()).valid

    def test_sidecar_receipt_is_tied_to_the_verified_attestation(self):
        result = evaluate_attestation(provider_id="p", router=Real.router(), boot=Real.boot(), certificate=Real.cert_pem(), now_ms=NOW_MS)
        bound = result.bound
        assert bound is not None
        v = verify_sidecar_receipt(Real.receipt(), bound)
        assert v.valid and v.status("sidecar.attestation_ref") == "pass" and v.status("sidecar.model_digest") == "pass"
        bound.attestation_ref = "ab" * 32
        assert not verify_sidecar_receipt(Real.receipt(), bound).valid


class TestRouterReceipts:
    payload = {"v": 1, "id": "gen-1", "issued": "2026-09-15T10:00:00.000Z", "model": "m", "provider": "p", "tokens": {"prompt": 3, "completion": 4}, "cost": "0.00001"}

    def test_verifies_against_the_published_key_set_only(self):
        k = RouterKey()
        r = k.sign(self.payload)
        v = verify_receipt(r, keys={"keys": [k.jwk]})
        assert v.valid and v.status("key_window") == "pass"
        assert not verify_receipt(r, keys={"keys": []}).valid
        assert not verify_receipt(r, keys=[RouterKey().jwk]).valid

    def test_a_key_entry_whose_id_does_not_match_its_bytes_is_rejected(self):
        k = RouterKey()
        liar = {**k.jwk, "x": RouterKey().jwk["x"]}
        v = verify_receipt(k.sign(self.payload), keys=[liar])
        assert not v.valid and v.status("key") == "fail"

    def test_a_receipt_dated_outside_its_keys_window_is_flagged(self):
        k = RouterKey("2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z")
        late = verify_receipt(k.sign({**self.payload, "issued": "2026-09-20T00:00:00.000Z"}), keys=[k.jwk])
        assert not late.valid and late.status("key_window") == "fail"
        assert verify_receipt(k.sign({**self.payload, "issued": "2026-09-05T00:00:00.000Z"}), keys=[k.jwk]).valid

    @pytest.mark.parametrize("bad", [None, {}, {"payload": {}, "sig": "", "key_id": ""}, {"payload": 5, "sig": "x", "key_id": "y"}])
    def test_malformed_input_is_a_failed_verification_not_an_exception(self, bad):
        assert not verify_receipt(bad, keys=[]).valid  # type: ignore[arg-type]

    def test_key_set_parsing(self):
        with pytest.raises(ValueError):
            parse_key_set({"nope": 1})
        with pytest.raises(ValueError):
            parse_key_set({"keys": [{"kid": "a"}]})

    def test_fetch_reads_the_well_known_path(self):
        k = RouterKey()
        seen: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append(str(req.url))
            return httpx.Response(200, json={"keys": [k.jwk]})

        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            assert fetch_receipt_keys("https://router.test/", http)[0]["kid"] == k.kid
        assert seen == ["https://router.test/.well-known/anyroute-receipt-keys.json"]
        with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404))) as http, pytest.raises(RuntimeError, match="404"):
            fetch_receipt_keys("https://router.test", http)


class TestAnchor:
    @staticmethod
    def pair(a: bytes, b: bytes) -> bytes:
        return keccak256(a + b if a < b else b + a)

    def test_sorted_pair_proofs(self):
        leaves = [keccak256(bytes([n])) for n in range(4)]
        l01, l23 = self.pair(leaves[0], leaves[1]), self.pair(leaves[2], leaves[3])
        root = self.pair(l01, l23)
        h = lambda b: "0x" + b.hex()  # noqa: E731
        assert verify_merkle_proof(h(leaves[2]), [h(leaves[3]), h(l01)], h(root))
        assert not verify_merkle_proof(h(leaves[2]), [h(leaves[3]), h(l23)], h(root))
        assert not verify_merkle_proof(h(leaves[1]), [h(leaves[3]), h(l01)], h(root))
        assert verify_merkle_proof(h(leaves[2]), [], h(leaves[2]))
        assert not verify_merkle_proof("nothex", [], h(root))

    def test_a_proof_is_reported_and_a_bad_one_fails_the_receipt(self):
        k = RouterKey()
        r = k.sign({"v": 1, "id": "g", "issued": "2026-09-15T00:00:00.000Z"})
        sibling = keccak256(b"\x09")
        leaf = bytes.fromhex(r["leaf"][2:])
        root = self.pair(leaf, sibling)
        anchored = {**r, "anchor": {"root": "0x" + root.hex(), "proof": ["0x" + sibling.hex()], "index": 7, "leaf_index": 0}}
        v = verify_receipt(anchored, keys=[k.jwk])
        assert v.anchor == "proof_valid" and v.valid
        bad = clone(anchored)
        bad["anchor"]["proof"] = ["0x" + keccak256(b"\x0a").hex()]
        w = verify_receipt(bad, keys=[k.jwk])
        assert w.anchor == "proof_invalid" and not w.valid

    def test_leaf_is_the_double_keccak_of_payload_and_signature(self):
        r = Real.receipt()
        assert receipt_leaf(canonical_bytes(r["payload"]), base64.b64decode(r["sig"])) == r["leaf"]


def test_client_reloads_keys_once_on_rotation():
    first, second = RouterKey(), RouterKey()
    published = [first.jwk]
    reads: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        reads.append(1)
        return httpx.Response(200, json={"keys": published})

    client = AnyRoute("https://router.test", http=httpx.Client(transport=httpx.MockTransport(handler)))
    client.receipt_keys()
    published = [first.jwk, second.jwk]
    assert client.verify_receipt(second.sign({"v": 1, "id": "x", "issued": "2026-09-15T00:00:00.000Z"})).valid
    assert len(reads) == 2
    assert not client.verify_receipt(RouterKey().sign({"v": 1, "id": "y"})).valid
    assert len(reads) == 3
