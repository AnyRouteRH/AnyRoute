from __future__ import annotations

from typing import Any

from .types import ProviderVerification, ReceiptVerification


class AnyRouteError(Exception):
    def __init__(self, message: str, code: str, status: int | None = None, details: Any = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


class AttestationRefused(AnyRouteError):
    """Raised before anything is sent: the provider could not be verified. ``verification.checks`` says which check failed."""

    def __init__(self, verification: ProviderVerification):
        super().__init__(
            f"Refusing to send: provider {verification.provider_id} is not verified. " + " ".join(verification.failures),
            "attestation_refused",
            None,
            verification.failures,
        )
        self.verification = verification


class ReceiptInvalid(AnyRouteError):
    def __init__(self, verification: ReceiptVerification):
        super().__init__("The receipt on this response did not verify.", "receipt_invalid", None, [c for c in verification.checks if c.status == "fail"])
        self.verification = verification
