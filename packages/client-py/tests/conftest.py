from __future__ import annotations

import base64
import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from anyroute_client import canonical_bytes, key_id_of, receipt_leaf

# The same recorded TDX evidence the TypeScript package is tested with.
FIXTURES = Path(__file__).resolve().parents[2] / "client" / "test" / "fixtures"

# A moment inside the recorded evidence's lifetime: the router had verified it ten minutes earlier.
NOW_MS = datetime.fromisoformat("2026-09-29T08:30:00+00:00").timestamp() * 1000


def load_json(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


class Real:
    """Recorded evidence, freshly parsed on every access so tests can mutate their copy."""

    @staticmethod
    def boot() -> dict:
        return load_json("attest-boot.json")

    @staticmethod
    def fresh() -> dict:
        return load_json("attest-fresh.json")

    @staticmethod
    def router() -> dict:
        return load_json("router-attestation.json")

    @staticmethod
    def receipt() -> dict:
        return load_json("receipt.json")

    @staticmethod
    def cert_pem() -> str:
        return (FIXTURES / "sidecar-cert.crt").read_text()

    @staticmethod
    def quote_hex() -> str:
        return (FIXTURES / "quote-boot.hex").read_text().strip()


@pytest.fixture
def real() -> type[Real]:
    return Real


def flip_last(h: str) -> str:
    return h[:-1] + format(int(h[-1], 16) ^ 1, "x")


class RouterKey:
    def __init__(self, valid_from: str = "2026-09-01T00:00:00.000Z", retired_at: str | None = None) -> None:
        self.private = Ed25519PrivateKey.generate()
        raw = self.private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.kid = key_id_of(raw)
        self.jwk = {"kty": "OKP", "crv": "Ed25519", "x": base64.urlsafe_b64encode(raw).rstrip(b"=").decode(), "kid": self.kid, "use": "sig", "alg": "EdDSA", "valid_from": valid_from, "retired_at": retired_at, "onchain_tx": None}

    def sign(self, payload: dict) -> dict:
        canonical = canonical_bytes(payload)
        sig = self.private.sign(canonical)
        return {"id": payload.get("id", "rcpt"), "payload": payload, "sig": base64.b64encode(sig).decode(), "key_id": self.kid, "alg": "Ed25519", "leaf": receipt_leaf(canonical, sig)}


@pytest.fixture
def router_key() -> type[RouterKey]:
    return RouterKey


def clone(x: Any) -> Any:
    return copy.deepcopy(x)
