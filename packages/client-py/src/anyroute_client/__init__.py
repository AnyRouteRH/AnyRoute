"""Anyroute client: receipt verification and verify-before-send for attested providers."""

from .attestation import ATTEST_SAN_SUFFIX, attest_san_for, digest_hex, evaluate_attestation, fetch_router_attestation, verify_provider
from .canonical import canonical_bytes, canonical_json
from .agent import AgentPolicy, AgentLane, AgentIntent, AgentReason, AgentDecision, AgentRemaining, AgentRulebook
from .agent_errors import AgentPolicyDenied, AgentKilled, AgentApprovalRequired
from .client import AnyRoute
from .errors import AnyRouteError, AttestationRefused, ReceiptInvalid
from .keccak import keccak256
from .receipts import RECEIPT_KEYS_PATH, fetch_receipt_keys, key_id_of, parse_key_set, receipt_leaf, verify_merkle_proof, verify_receipt, verify_sidecar_receipt
from .tdx import TdxFields, parse_tdx_quote
from .types import BoundIdentity, Check, ExpectedDigests, ProviderVerification, ReceiptVerification

__all__ = [
    "AgentPolicy", "AgentLane", "AgentIntent", "AgentReason", "AgentDecision", "AgentRemaining", "AgentRulebook",
    "AgentPolicyDenied", "AgentKilled", "AgentApprovalRequired",
    "ATTEST_SAN_SUFFIX",
    "AnyRoute",
    "AnyRouteError",
    "AttestationRefused",
    "BoundIdentity",
    "Check",
    "ExpectedDigests",
    "ProviderVerification",
    "RECEIPT_KEYS_PATH",
    "ReceiptInvalid",
    "ReceiptVerification",
    "TdxFields",
    "attest_san_for",
    "canonical_bytes",
    "canonical_json",
    "digest_hex",
    "evaluate_attestation",
    "fetch_receipt_keys",
    "fetch_router_attestation",
    "keccak256",
    "key_id_of",
    "parse_key_set",
    "parse_tdx_quote",
    "receipt_leaf",
    "verify_merkle_proof",
    "verify_provider",
    "verify_receipt",
    "verify_sidecar_receipt",
]
__version__ = "0.1.0"
