from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

CheckStatus = Literal["pass", "fail", "not_checked"]


@dataclass(frozen=True)
class Check:
    """One line of a verification report. ``not_checked`` is never a pass: it means this client did not look."""

    id: str
    status: CheckStatus
    detail: str


def passed(id: str, detail: str) -> Check:
    return Check(id, "pass", detail)


def failed(id: str, detail: str) -> Check:
    return Check(id, "fail", detail)


def skipped(id: str, detail: str) -> Check:
    return Check(id, "not_checked", detail)


@dataclass
class ReceiptVerification:
    valid: bool
    key_id: str
    checks: list[Check]
    anchor: Literal["proof_valid", "proof_invalid", "no_proof"]
    not_checked: list[str] = field(default_factory=list)

    def status(self, check_id: str) -> str | None:
        return next((c.status for c in self.checks if c.id == check_id), None)


@dataclass
class BoundIdentity:
    attestation_ref: str
    attestation_san: str
    tls_pubkey: str
    receipt_pubkey: str
    receipt_key_id: str | None
    hpke_pubkey: str | None
    image_digest: str
    compose_hash: str
    model_digest: str
    measurements: dict[str, str] | None
    tee_kind: str | None


@dataclass
class ProviderVerification:
    ok: bool
    provider_id: str
    simulated: bool
    checks: list[Check]
    failures: list[str]
    bound: BoundIdentity | None
    router: dict[str, Any] | None
    attested_at: str | None
    verified_at: str
    not_checked: list[str] = field(default_factory=list)

    def status(self, check_id: str) -> str | None:
        return next((c.status for c in self.checks if c.id == check_id), None)


@dataclass
class ExpectedDigests:
    model_digest: str | None = None
    image_digest: str | None = None
    compose_hash: str | None = None
    mrtd: str | None = None
    rtmr3: str | None = None
