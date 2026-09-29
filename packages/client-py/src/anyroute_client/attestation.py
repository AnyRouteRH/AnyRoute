"""Verify-before-send. Before a request goes to an attested provider the client reads two documents and refuses unless
they agree with each other and with the quote inside them:

1. the router's record, ``GET /api/v1/attestation/:providerId``: has the router itself verified a quote recently, and
   which digests did it record;
2. the provider's own ``/attest`` document: a TDX quote whose report_data commits to the provider's TLS key, receipt key
   and image / compose / model digests, and whose SHA-256 is the reference carried in its TLS certificate.

The client does not repeat Intel's quote-signature check (that needs collateral from Intel's services); it says so in
``not_checked``, and a caller who can run one passes ``quote_verifier``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .canonical import canonical_json
from .tdx import TdxFields, parse_tdx_quote
from .types import BoundIdentity, Check, ExpectedDigests, ProviderVerification, failed, passed, skipped

ATTEST_SAN_SUFFIX = "attest.anyroute"
_REGISTERS = ("mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3")
_NOT_CHECKED_GENERIC = [
    "That prompts stay inside the enclave: attestation shows what software is running and on what hardware, not what it does with data.",
    "That the running software matches its published source: reproducible-build provenance is not checked here.",
]

QuoteVerifier = Callable[[str], "tuple[bool, str | None]"]


def attest_san_for(ref: str) -> str:
    return f"{ref[:32]}.{ref[32:]}.{ATTEST_SAN_SUFFIX}"


def digest_hex(value: Any) -> str | None:
    """``sha256:<hex>``, ``0x<hex>`` and bare hex all compare as the lowercase hex."""
    if not isinstance(value, str):
        return None
    m = re.fullmatch(r"(?:sha256:)?(?:0x)?([0-9a-fA-F]{64})", value.strip())
    return m.group(1).lower() if m else None


def _same(a: Any, b: Any) -> bool:
    x, y = digest_hex(a), digest_hex(b)
    return x is not None and y is not None and x == y


def _is_hex(value: Any, n_bytes: int | None = None) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"(?:0x)?(?:[0-9a-fA-F]{2})+", value):
        return False
    return n_bytes is None or len(re.sub(r"^0x", "", value, flags=re.I)) == n_bytes * 2


def _parse_time(value: str | None) -> float:
    if not value:
        return float("nan")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return float("nan")


def _safe(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception:  # noqa: BLE001 - any parse failure means "not usable"
        return None


def _load_cert(certificate: bytes | str) -> x509.Certificate:
    if isinstance(certificate, str):
        return x509.load_pem_x509_certificate(certificate.encode())
    return x509.load_der_x509_certificate(certificate)


def evaluate_attestation(
    *,
    provider_id: str,
    router: dict[str, Any] | None,
    boot: dict[str, Any] | None,
    fresh: tuple[dict[str, Any], str] | None = None,
    certificate: bytes | str | None = None,
    expected: ExpectedDigests | None = None,
    allow_simulated: bool = False,
    require_certificate: bool = False,
    max_attestation_age_ms: float = 3_600_000,
    quote_verifier: QuoteVerifier | None = None,
    now_ms: float | None = None,
) -> ProviderVerification:
    """Pure evaluation of the two documents (and an optional certificate). No network. Every judgement is a Check; ``ok``
    is true only when nothing failed and every check treated as required actually passed. ``fresh`` is ``(document,
    nonce_hex)`` from ``/attest?nonce=``."""
    now = now_ms if now_ms is not None else time.time() * 1000
    checks: list[Check] = []
    required: set[str] = set()

    def need(c: Check) -> None:
        required.add(c.id)
        checks.append(c)

    router_simulated = bool(router) and (router.get("status") == "simulated" or router.get("tee") == "dev")
    if not router:
        need(failed("router.status", "The router returned no attestation record for this provider."))
    elif router.get("status") == "attested":
        need(passed("router.status", "The router reports this provider as attested."))
    elif router.get("status") == "simulated":
        need(passed("router.status", "SIMULATED: the router reports development evidence, accepted because allow_simulated was set.") if allow_simulated else failed("router.status", "The router reports simulated (development) evidence, which proves nothing about hardware."))
    else:
        reason = f" ({router['reason']})" if router.get("reason") else ""
        need(failed("router.status", f"The router reports this provider as unverified{reason}."))
    if router:
        rc = router.get("checks") or {}
        if router_simulated and allow_simulated:
            checks.append(skipped("router.quote_verified", "Simulated evidence has no hardware quote to verify."))
        else:
            v = router.get("verifiers") or []
            need(passed("router.quote_verified", "The router verified the quote" + (f" with {', '.join(v)}" if v else "") + ".") if rc.get("quote_verified") is True else failed("router.quote_verified", "The router has not verified a quote for this provider."))
        checks.append(
            passed("router.digests_recorded", "The router recorded the image, compose and model digests as committed inside the verified quote.")
            if rc.get("digests_bound_to_quote")
            else skipped("router.digests_recorded", "The router has not recorded the digests as bound to a verified quote. Only this client's own check of the provider's document backs them.")
        )
        at = _parse_time(router.get("attested_at"))
        fresh_ok = at == at and now - at <= max_attestation_age_ms and at - now < 300_000
        need(passed("router.fresh", f"Verified by the router at {router.get('attested_at')}.") if fresh_ok else failed("router.fresh", f"The router's verification is missing or older than {round(max_attestation_age_ms / 60000)} minutes."))

    bound: BoundIdentity | None = None
    simulated = router_simulated
    if boot is None:
        need(failed("provider.document", "The provider's /attest document was not read."))
    else:
        ev = boot.get("evidence") or {}
        dev_doc = boot.get("dev") is True or ev.get("dev") is True or ev.get("kind") == "dev" or ev.get("format") == "dev-simulated"
        simulated = simulated or dev_doc
        if dev_doc or router_simulated:
            need(passed("provider.simulated", "SIMULATED evidence accepted because allow_simulated was set. No hardware is behind it.") if allow_simulated else failed("provider.simulated", "The evidence is simulated (development only). It proves nothing about hardware and is refused."))
        else:
            need(passed("provider.simulated", "The evidence is not marked as simulated."))

        b = boot.get("bindings") or {}
        ref = str(boot.get("attestation_ref") or "").lower()
        bindings_ok = (
            _is_hex(b.get("tls_pubkey"))
            and _is_hex(b.get("receipt_pubkey"), 32)
            and bool(digest_hex(b.get("image_digest")))
            and bool(digest_hex(b.get("compose_hash")))
            and bool(digest_hex(b.get("model_digest")))
            and (b.get("hpke_pubkey") is None or _is_hex(b.get("hpke_pubkey")))
        )
        need(passed("provider.bindings", "The document names a TLS key, a receipt key and image, compose and model digests.") if bindings_ok else failed("provider.bindings", "The bindings are missing a TLS key, a receipt key or a valid image, compose or model digest."))

        fields: TdxFields | None = None
        quote_bytes: bytes | None = None
        if ev.get("format") == "tdx-quote-v4" and isinstance(ev.get("quote"), str):
            try:
                quote_bytes = bytes.fromhex(ev["quote"])
                fields = parse_tdx_quote(quote_bytes)
            except ValueError as e:
                need(failed("provider.quote", f"The quote cannot be read: {e}"))
            if fields:
                need(passed("provider.quote", "The quote parses as an Intel TDX version 4 quote."))
        elif dev_doc:
            checks.append(skipped("provider.quote", "Simulated evidence carries no hardware quote."))
        else:
            need(failed("provider.quote", f"Unsupported evidence format {ev.get('format')}."))

        if quote_bytes is not None and ev.get("boot") is not False and ev.get("nonce") is None:
            h = hashlib.sha256(quote_bytes).hexdigest()
            need(passed("provider.ref_is_quote_hash", "attestation_ref equals SHA-256 of the quote.") if h == ref else failed("provider.ref_is_quote_hash", "attestation_ref is not the SHA-256 of the quote in the document."))
        elif dev_doc:
            checks.append(skipped("provider.ref_is_quote_hash", "Not applicable to simulated evidence."))
        else:
            need(failed("provider.ref_is_quote_hash", "The document is not the boot quote, so its hash cannot be compared with the reference."))
        expected_san = attest_san_for(ref) if re.fullmatch(r"[0-9a-f]{64}", ref) else None
        need(passed("provider.san_is_ref", f"The certificate name is {expected_san}.") if expected_san and boot.get("attestation_san") == expected_san else failed("provider.san_is_ref", "attestation_san is not derived from attestation_ref."))

        if fields:
            digest = hashlib.sha256(canonical_json(b).encode()).hexdigest()
            need(
                passed("provider.report_data", "The quote's report_data is SHA-256(bindings) followed by a zero nonce: the TLS key, receipt key and digests are committed in the quote.")
                if fields.report_data == digest + "0" * 64
                else failed("provider.report_data", "The quote's report_data does not commit to these bindings.")
            )
            claimed = ev.get("measurements") or {}
            mism = [r for r in _REGISTERS if r in claimed and claimed[r] != getattr(fields, r)]
            all_listed = all(r in claimed for r in _REGISTERS)
            need(
                passed("provider.measurements", "The measurement registers in the document are the ones inside the quote.")
                if not mism and all_listed
                else failed("provider.measurements", f"Registers differ from the quote: {', '.join(mism)}." if mism else "The document does not list the quote's measurement registers.")
            )
        elif dev_doc:
            checks.append(skipped("provider.report_data", "Not applicable to simulated evidence."))

        if bindings_ok:
            rk = boot.get("receipt_key")
            hpke = b["hpke_pubkey"].removeprefix("0x").lower() if isinstance(b.get("hpke_pubkey"), str) else None
            bound = BoundIdentity(
                attestation_ref=ref,
                attestation_san=boot.get("attestation_san") or "",
                tls_pubkey=b["tls_pubkey"].lower(),
                receipt_pubkey=b["receipt_pubkey"].lower(),
                receipt_key_id=rk.get("key_id") if rk else None,
                hpke_pubkey=hpke,
                image_digest="sha256:" + digest_hex(b["image_digest"]),  # type: ignore[operator]
                compose_hash="sha256:" + digest_hex(b["compose_hash"]),  # type: ignore[operator]
                model_digest="sha256:" + digest_hex(b["model_digest"]),  # type: ignore[operator]
                measurements={r: getattr(fields, r) for r in _REGISTERS} if fields else None,
                tee_kind=ev.get("kind"),
            )
            if rk:
                consistent = str(rk.get("public_key", "")).lower() == bound.receipt_pubkey
                need(passed("provider.receipt_key", f"Receipts from this provider are signed by key {rk.get('key_id')}, which the quote commits to.") if consistent else failed("provider.receipt_key", "The receipt key in the document is not the one committed in the bindings."))
            else:
                need(failed("provider.receipt_key", "The document does not state its receipt key."))

        if fresh is not None:
            f, nonce_hex = fresh
            fev = f.get("evidence") or {}
            fq = _safe(lambda: parse_tdx_quote(bytes.fromhex(fev["quote"]))) if fev.get("format") == "tdx-quote-v4" else None
            fdigest = hashlib.sha256(canonical_json(f.get("bindings") or {}).encode()).hexdigest()
            same_bindings = canonical_json(f.get("bindings") or {}) == canonical_json(b) and f.get("attestation_ref") == boot.get("attestation_ref")
            echoed = fev.get("nonce") is not None and str(fev["nonce"]).removeprefix("0x").lower() == nonce_hex.lower()
            same_regs = bool(fq) and bool(fields) and all(getattr(fq, r) == getattr(fields, r) for r in _REGISTERS)
            rd = bool(fq) and fq.report_data == fdigest + nonce_hex.lower()
            need(
                passed("provider.fresh_quote", "A fresh quote bound to a nonce chosen by this client carries the same bindings and measurements as the boot quote.")
                if echoed and rd and same_bindings and same_regs
                else failed("provider.fresh_quote", "The fresh quote does not bind our nonce, or differs from the boot quote in its bindings or measurements.")
            )
        else:
            checks.append(skipped("provider.fresh_quote", "No fresh nonce quote was requested; only the boot quote was read."))

    if certificate:
        try:
            cert = _load_cert(certificate)
            want_san = (bound.attestation_san if bound else "") or (str(boot.get("attestation_san") or "") if boot else "")
            names = [n.lower() for n in cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)]
            need(passed("provider.tls_san", "The connection's certificate carries the attestation name, so it belongs to the attested instance.") if want_san and want_san.lower() in names else failed("provider.tls_san", "The certificate does not carry the attestation name derived from the quote's hash: this transport is not bound to the quote."))
            spki = cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo).hex()
            need(passed("provider.tls_key", "The certificate's public key is the TLS key committed in the quote.") if bound and spki == bound.tls_pubkey else failed("provider.tls_key", "The certificate's public key is not the TLS key committed in the quote."))
            nb = cert.not_valid_before_utc.timestamp() * 1000
            na = cert.not_valid_after_utc.timestamp() * 1000
            need(passed("provider.tls_valid", "The certificate is inside its validity period.") if nb - 300_000 <= now <= na else failed("provider.tls_valid", "The certificate is outside its validity period."))
        except Exception as e:  # noqa: BLE001
            need(failed("provider.tls_san", f"The certificate cannot be read: {e}"))
    elif require_certificate:
        need(failed("provider.tls_san", "A certificate was required but none was available, so the transport is not bound to the quote."))
    else:
        checks.append(skipped("provider.tls_san", "No connection certificate was available, so the transport is not checked against the quote."))

    measurement = router.get("measurement") if router else None
    if measurement and bound:
        mism = [name for name, ok in (("image", _same(measurement.get("image_digest"), bound.image_digest)), ("compose", _same(measurement.get("compose_hash"), bound.compose_hash)), ("model", _same(measurement.get("model_digest"), bound.model_digest))) if not ok]
        need(passed("router.matches_provider", "The router's recorded digests equal the provider's bound digests.") if not mism else failed("router.matches_provider", f"The router's recorded {', '.join(mism)} digest differs from what the provider's quote commits to."))
    else:
        checks.append(skipped("router.matches_provider", "The router has no measurement recorded to compare with."))

    ex = expected or ExpectedDigests()

    def expect(check_id: str, label: str, want: str | None, got: str | None, cmp: Callable[[str, str], bool]) -> None:
        if want is None:
            checks.append(skipped(check_id, f"No expected {label} supplied."))
        elif not got:
            need(failed(check_id, f"The provider's {label} is unknown, so it cannot match the one you expect."))
        else:
            need(passed(check_id, f"The {label} equals the one you expect.") if cmp(want, got) else failed(check_id, f"The provider's {label} is not the one you expect."))

    hex_eq = lambda a, b: a.removeprefix("0x").lower() == b.lower()  # noqa: E731
    expect("expected.model", "model digest", ex.model_digest, bound.model_digest if bound else None, _same)
    expect("expected.image", "image digest", ex.image_digest, bound.image_digest if bound else None, _same)
    expect("expected.compose", "compose hash", ex.compose_hash, bound.compose_hash if bound else None, _same)
    expect("expected.mrtd", "MRTD register", ex.mrtd, bound.measurements["mrtd"] if bound and bound.measurements else None, hex_eq)
    expect("expected.rtmr3", "RTMR3 register", ex.rtmr3, bound.measurements["rtmr3"] if bound and bound.measurements else None, hex_eq)

    if quote_verifier and boot and (boot.get("evidence") or {}).get("quote") and not simulated:
        try:
            ok, detail = quote_verifier(boot["evidence"]["quote"])
            need(passed("quote.signature", detail or "The supplied quote verifier accepted the quote.") if ok else failed("quote.signature", detail or "The supplied quote verifier rejected the quote."))
        except Exception as e:  # noqa: BLE001
            need(failed("quote.signature", f"The quote verifier failed: {e}"))
    else:
        checks.append(skipped("quote.signature", "This client does not check Intel's signature and certificate chain over the quote; it relies on the router's verification (router.quote_verified). Pass quote_verifier to check it yourself."))

    failures = [c.detail for c in checks if c.status == "fail"]
    all_required = all(any(c.id == cid and c.status == "pass" for c in checks) for cid in required)
    not_checked = list(router.get("not_checked") or _NOT_CHECKED_GENERIC) if router else list(_NOT_CHECKED_GENERIC)
    if ex.model_digest is None:
        not_checked.append("That the model digest is the model you wanted: no expected digest was supplied, so the bound digest is reported but not compared.")
    if not quote_verifier:
        not_checked.append("Intel's signature and certificate chain over the quote: this client relies on the router's verification.")
    return ProviderVerification(
        ok=not failures and all_required and (not simulated or allow_simulated),
        provider_id=provider_id,
        simulated=simulated,
        checks=checks,
        failures=failures,
        bound=bound,
        router=router,
        attested_at=router.get("attested_at") if router else None,
        verified_at=datetime.fromtimestamp(now / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        not_checked=not_checked,
    )


def _attest_base(url: str) -> str:
    return re.sub(r"/$", "", re.sub(r"/attest/?(\?.*)?$", "", url))


def fetch_router_attestation(router_url: str, provider_id: str, http: httpx.Client) -> dict[str, Any] | None:
    res = http.get(f"{router_url.rstrip('/')}/api/v1/attestation/{provider_id}", headers={"accept": "application/json"})
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise RuntimeError(f"GET /api/v1/attestation/{provider_id} failed with {res.status_code}")
    return res.json()["data"]


def verify_provider(
    *,
    router_url: str,
    provider_id: str,
    attest_url: str | None = None,
    http: httpx.Client | None = None,
    attest_http: httpx.Client | None = None,
    fresh_nonce: bool = True,
    nonce_hex: str | None = None,
    certificate: bytes | str | None = None,
    **options: Any,
) -> ProviderVerification:
    """Fetch both documents and evaluate them. Never raises for a bad provider: the result says ``ok=False`` and why.

    ``attest_http`` is the client used for the provider. A sidecar serves its own self-signed certificate: to reach it
    pass a client that trusts that certificate, or read the certificate from the connection yourself and pass it as
    ``certificate`` (it is then compared with the quote)."""
    own_http = http is None
    client = http or httpx.Client(timeout=20)
    provider_client = attest_http or client
    fetch_error: str | None = None
    router: dict[str, Any] | None = None
    boot: dict[str, Any] | None = None
    fresh: tuple[dict[str, Any], str] | None = None
    try:
        try:
            router = fetch_router_attestation(router_url, provider_id, client)
        except Exception as e:  # noqa: BLE001
            fetch_error = f"The router's attestation record could not be read: {e}"
        if fetch_error is None and attest_url:
            base = _attest_base(attest_url)
            try:
                res = provider_client.get(f"{base}/attest", headers={"accept": "application/json"})
                res.raise_for_status()
                boot = res.json()
                if fresh_nonce:
                    nonce = nonce_hex or os.urandom(32).hex()
                    res = provider_client.get(f"{base}/attest", params={"nonce": nonce}, headers={"accept": "application/json"})
                    res.raise_for_status()
                    fresh = (res.json(), nonce)
            except Exception as e:  # noqa: BLE001
                fetch_error = f"The provider's /attest could not be read: {e}"
    finally:
        if own_http:
            client.close()
    result = evaluate_attestation(provider_id=provider_id, router=router, boot=boot, fresh=fresh, certificate=certificate, **options)
    if fetch_error:
        result.checks.append(failed("fetch", fetch_error))
        result.failures.append(fetch_error)
        result.ok = False
    return result
