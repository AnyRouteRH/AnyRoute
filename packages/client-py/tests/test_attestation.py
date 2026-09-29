from __future__ import annotations

import hashlib

import httpx
import pytest

from anyroute_client import ExpectedDigests, canonical_json, evaluate_attestation, verify_provider

from .conftest import NOW_MS, Real, clone, flip_last

MODEL = "sha256:1144b5db331424ae40213378a83575a5cf67090b0ce1ad49cf66ec75f17e2095"


def base(**over):
    fresh = Real.fresh()
    args = dict(provider_id="example-provider", router=Real.router(), boot=Real.boot(), fresh=(fresh["response"], fresh["nonce"]), certificate=Real.cert_pem(), now_ms=NOW_MS)
    args.update(over)
    return args


class TestRealEvidence:
    def test_passes_every_check_this_client_can_make_and_says_what_it_did_not_check(self):
        v = evaluate_attestation(**base(expected=ExpectedDigests(model_digest=MODEL)))
        assert v.failures == [] and v.ok and not v.simulated
        for cid in ("router.status", "router.quote_verified", "router.fresh", "router.matches_provider", "provider.simulated", "provider.quote", "provider.ref_is_quote_hash", "provider.san_is_ref", "provider.report_data", "provider.measurements", "provider.receipt_key", "provider.fresh_quote", "provider.tls_san", "provider.tls_key", "provider.tls_valid", "expected.model"):
            assert (cid, v.status(cid)) == (cid, "pass")
        assert v.status("quote.signature") == "not_checked"  # nobody here verified Intel's signature
        assert v.status("expected.image") == "not_checked"
        assert v.bound.model_digest == MODEL
        assert v.bound.receipt_key_id == "644b0e2c91520ec4"
        assert v.bound.attestation_ref == "2407bc5921f607291e765ada315fd731b5a97b7e037def81d0fb53714f7dd760"

    def test_the_certificate_name_is_derived_from_the_sha256_of_the_quote(self):
        boot = Real.boot()
        ref = hashlib.sha256(bytes.fromhex(boot["evidence"]["quote"])).hexdigest()
        assert ref == boot["attestation_ref"]
        assert boot["attestation_san"] == f"{ref[:32]}.{ref[32:]}.attest.anyroute"

    def test_without_a_certificate_the_transport_is_not_checked_and_can_be_required(self):
        v = evaluate_attestation(**base(certificate=None))
        assert v.ok and v.status("provider.tls_san") == "not_checked"
        strict = evaluate_attestation(**base(certificate=None, require_certificate=True))
        assert not strict.ok and strict.status("provider.tls_san") == "fail"

    def test_stale_router_verification_and_expired_certificate(self):
        assert evaluate_attestation(**base(now_ms=NOW_MS + 2 * 3_600_000)).status("router.fresh") == "fail"
        assert evaluate_attestation(**base(now_ms=NOW_MS + 2 * 3_600_000, max_attestation_age_ms=3 * 3_600_000)).ok
        late = evaluate_attestation(**base(now_ms=1_796_000_000_000, max_attestation_age_ms=1e12))
        assert late.status("provider.tls_valid") == "fail" and not late.ok


class TestRefusals:
    @pytest.mark.parametrize("router", [{"status": "unverified", "reason": "attestation_stale"}, {"status": "simulated", "tee": "dev"}, None])
    def test_router_says_unverified_simulated_or_nothing(self, router):
        r = None if router is None else {**Real.router(), **router}
        v = evaluate_attestation(**base(router=r))
        assert not v.ok and v.status("router.status") == "fail"

    def test_router_has_not_verified_a_quote(self):
        r = Real.router()
        r["checks"]["quote_verified"] = False
        v = evaluate_attestation(**base(router=r))
        assert not v.ok and v.status("router.quote_verified") == "fail"

    def test_altered_quote_bytes_break_the_reference_and_the_bindings(self):
        boot = Real.boot()
        q = bytearray(bytes.fromhex(boot["evidence"]["quote"]))
        q[48 + 520 + 3] ^= 1
        boot["evidence"]["quote"] = q.hex()
        v = evaluate_attestation(**base(boot=boot, fresh=None))
        assert not v.ok
        assert v.status("provider.ref_is_quote_hash") == "fail" and v.status("provider.report_data") == "fail"
        assert v.status("provider.measurements") == "pass"

    @pytest.mark.parametrize("field", ["tls_pubkey", "receipt_pubkey", "image_digest", "compose_hash", "model_digest"])
    def test_bindings_the_quote_does_not_commit_to_are_rejected(self, field):
        boot = Real.boot()
        boot["bindings"][field] = flip_last(boot["bindings"][field])
        v = evaluate_attestation(**base(boot=boot, fresh=None))
        assert not v.ok and v.status("provider.report_data") == "fail"

    def test_an_extra_binding_the_quote_does_not_cover(self):
        boot = Real.boot()
        boot["bindings"]["hpke_pubkey"] = "aa" * 32
        v = evaluate_attestation(**base(boot=boot, fresh=None))
        assert not v.ok and v.status("provider.report_data") == "fail"

    def test_registers_claimed_that_differ_from_the_quote(self):
        boot = Real.boot()
        boot["evidence"]["measurements"]["mrtd"] = "00" * 48
        v = evaluate_attestation(**base(boot=boot, fresh=None))
        assert v.status("provider.measurements") == "fail" and not v.ok

    def test_certificate_name_not_derived_from_the_quote(self):
        boot = Real.boot()
        boot["attestation_san"] = "0" + boot["attestation_san"][1:]
        v = evaluate_attestation(**base(boot=boot, fresh=None))
        assert v.status("provider.san_is_ref") == "fail" and v.status("provider.tls_san") == "fail" and not v.ok

    def test_a_certificate_for_another_key_or_without_the_attestation_name(self):
        other = Real.boot()
        other["bindings"]["tls_pubkey"] = flip_last(other["bindings"]["tls_pubkey"])
        v = evaluate_attestation(**base(boot=other, fresh=None))
        assert v.status("provider.tls_key") == "fail" and not v.ok
        import base64

        der = bytearray(base64.b64decode("".join(l for l in Real.cert_pem().splitlines() if not l.startswith("-----"))))
        at = bytes(der).index(b"attest.anyroute")
        der[at] ^= 1
        forged = "-----BEGIN CERTIFICATE-----\n" + base64.b64encode(bytes(der)).decode() + "\n-----END CERTIFICATE-----\n"
        w = evaluate_attestation(**base(certificate=forged, fresh=None))
        assert w.status("provider.tls_san") == "fail" and not w.ok

    def test_router_digests_must_equal_the_providers_bound_ones(self):
        r = Real.router()
        r["measurement"]["model_digest"] = "0x" + "ab" * 32
        v = evaluate_attestation(**base(router=r))
        assert v.status("router.matches_provider") == "fail" and not v.ok

    def test_expected_digests(self):
        bad = evaluate_attestation(**base(expected=ExpectedDigests(model_digest="sha256:" + "ab" * 32)))
        assert not bad.ok and bad.status("expected.model") == "fail"
        good = evaluate_attestation(**base(expected=ExpectedDigests(model_digest="0x" + MODEL[7:], compose_hash="4BB1069E88343C2F600F3C08B4460BE233E50094253BF2E5DC27208CDF0DB583", mrtd=Real.boot()["evidence"]["measurements"]["mrtd"])))
        assert good.ok and good.status("expected.compose") == "pass" and good.status("expected.mrtd") == "pass"

    def test_fresh_quote_must_bind_our_nonce_and_match_the_boot_quote(self):
        fresh = Real.fresh()
        wrong_nonce = evaluate_attestation(**base(fresh=(fresh["response"], "00" * 32)))
        assert wrong_nonce.status("provider.fresh_quote") == "fail" and not wrong_nonce.ok
        doc = clone(fresh["response"])
        doc["bindings"]["model_digest"] = "sha256:" + "cd" * 32
        assert evaluate_attestation(**base(fresh=(doc, fresh["nonce"]))).status("provider.fresh_quote") == "fail"

    def test_simulated_evidence_is_refused_unless_the_caller_opts_in_and_is_still_labelled(self):
        boot = Real.boot()
        boot["dev"] = True
        boot["evidence"].update(dev=True, kind="dev", format="dev-simulated")
        v = evaluate_attestation(**base(boot=boot, fresh=None, certificate=None))
        assert not v.ok and v.simulated and v.status("provider.simulated") == "fail"
        sim_router = {**Real.router(), "status": "simulated", "tee": "dev"}
        sim_router["checks"]["quote_verified"] = False
        ok = evaluate_attestation(**base(boot=boot, fresh=None, certificate=None, router=sim_router, allow_simulated=True))
        assert ok.simulated and ok.status("provider.simulated") == "pass"
        assert "SIMULATED" in next(c.detail for c in ok.checks if c.id == "provider.simulated")

    def test_the_router_record_alone_is_never_enough(self):
        v = evaluate_attestation(provider_id="p", router=Real.router(), boot=None, now_ms=NOW_MS)
        assert not v.ok and v.status("provider.document") == "fail"

    def test_unsupported_format_or_unreadable_quote_is_a_failure(self):
        boot = Real.boot()
        boot["evidence"]["format"] = "sev-snp-report"
        assert not evaluate_attestation(**base(boot=boot, fresh=None)).ok
        boot2 = Real.boot()
        boot2["evidence"]["quote"] = "0400"
        v = evaluate_attestation(**base(boot=boot2, fresh=None))
        assert v.status("provider.quote") == "fail" and not v.ok

    def test_a_quote_verifier_supplied_by_the_caller_decides_the_signature_check(self):
        assert evaluate_attestation(**base(quote_verifier=lambda q: (True, "dcap: UpToDate"))).status("quote.signature") == "pass"
        assert not evaluate_attestation(**base(quote_verifier=lambda q: (False, "TCB revoked"))).ok

        def boom(q):
            raise RuntimeError("offline")

        assert not evaluate_attestation(**base(quote_verifier=boom)).ok


class TestVerifyProvider:
    @staticmethod
    def server(fresh_ok: bool = True, router_status: int = 200):
        seen: list[str] = []
        fresh = Real.fresh()

        def handler(req: httpx.Request) -> httpx.Response:
            path = req.url.path
            if path == "/api/v1/attestation/example-provider":
                return httpx.Response(router_status, json={"data": Real.router()})
            if path == "/attest":
                seen.append(req.url.query.decode())
                if req.url.params.get("nonce"):
                    return httpx.Response(200, json=fresh["response"]) if fresh_ok else httpx.Response(500)
                return httpx.Response(200, json=Real.boot())
            return httpx.Response(404, json={})

        return httpx.Client(transport=httpx.MockTransport(handler)), seen

    def test_reads_router_then_attest_then_a_fresh_nonce_and_passes(self):
        http, seen = self.server()
        v = verify_provider(router_url="https://router.test", provider_id="example-provider", attest_url="https://provider.test:8443/attest", http=http, nonce_hex=Real.fresh()["nonce"], certificate=Real.cert_pem(), now_ms=NOW_MS)
        assert v.failures == [] and v.ok
        assert seen == ["", f"nonce={Real.fresh()['nonce']}"]

    def test_a_random_nonce_cannot_be_answered_by_a_recorded_fresh_quote(self):
        http, _ = self.server()
        v = verify_provider(router_url="https://router.test", provider_id="example-provider", attest_url="https://provider.test", http=http, certificate=Real.cert_pem(), now_ms=NOW_MS)
        assert not v.ok and v.status("provider.fresh_quote") == "fail"

    def test_unknown_unreachable_and_erroring_are_refusals_with_a_reason(self):
        http, _ = self.server()
        missing = verify_provider(router_url="https://router.test", provider_id="nobody", attest_url="https://provider.test", http=http, now_ms=NOW_MS)
        assert not missing.ok and missing.status("router.status") == "fail"
        down = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"data": Real.router()}) if r.url.path.startswith("/api/") else httpx.Response(503)))
        unreachable = verify_provider(router_url="https://router.test", provider_id="example-provider", attest_url="https://provider.test", http=down, now_ms=NOW_MS)
        assert not unreachable.ok and unreachable.status("fetch") == "fail"
        err_http, _ = self.server(router_status=500)
        assert not verify_provider(router_url="https://router.test", provider_id="example-provider", attest_url="https://provider.test", http=err_http, now_ms=NOW_MS).ok

    def test_without_an_attest_url_only_the_routers_word_is_available(self):
        http, _ = self.server()
        assert not verify_provider(router_url="https://router.test", provider_id="example-provider", http=http, now_ms=NOW_MS).ok

    def test_bindings_digest_rule(self):
        boot = Real.boot()
        assert hashlib.sha256(canonical_json(boot["bindings"]).encode()).hexdigest() == boot["evidence"]["report_data"][:64]
