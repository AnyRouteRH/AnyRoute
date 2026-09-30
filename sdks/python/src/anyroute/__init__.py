"""The official Python SDK for Anyroute, an OpenRouter compatible AI router with signed receipts and privacy lanes.

    from anyroute import Anyroute

    client = Anyroute()  # reads ANYROUTE_API_KEY
    reply = client.chat.completions.create(model="meta-llama/llama-3.3-70b-instruct",messages=[{"role": "user", "content": "Hi"}])
    print(reply.content, reply.anyroute.receipt_id)
"""

from __future__ import annotations

from . import receipts
from ._async_client import AsyncAnyroute
from ._base import DEFAULT_BASE_URL
from ._client import Anyroute
from ._streaming import AsyncChatStream, ChatStream
from ._version import __version__
from .errors import (
    AnyrouteError,
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    RateLimitError,
    ReceiptInvalid,
)
from .lanes import DISCLOSURE_HEADER, DISCLOSURES, LANE_HEADER, LANES, merge_provider, stricter_disclosure, stricter_lane
from .receipts import (
    ChainCheck,
    ChainedEvent,
    Check,
    ReceiptVerification,
    VerificationResult,
    check_chain,
    chunk_chain,
    decode_receipt_v2,
    verify_merkle_proof,
    verify_receipt,
    verify_receipt_v1,
    verify_receipt_v2,
)
from .types import AnyrouteMeta, APIResponse, Batch, BatchResults, ChatCompletion, DataList, Embeddings, Model, Rerank

__all__ = [
    "__version__",
    "Anyroute",
    "AsyncAnyroute",
    "ChatStream",
    "AsyncChatStream",
    "DEFAULT_BASE_URL",
    "LANES",
    "DISCLOSURES",
    "LANE_HEADER",
    "DISCLOSURE_HEADER",
    "merge_provider",
    "stricter_lane",
    "stricter_disclosure",
    "AnyrouteError",
    "APIError",
    "APIConnectionError",
    "APITimeoutError",
    "AuthenticationError",
    "BadRequestError",
    "NotFoundError",
    "RateLimitError",
    "ReceiptInvalid",
    "receipts",
    "Check",
    "ChainCheck",
    "ChainedEvent",
    "ReceiptVerification",
    "VerificationResult",
    "check_chain",
    "chunk_chain",
    "decode_receipt_v2",
    "verify_merkle_proof",
    "verify_receipt",
    "verify_receipt_v1",
    "verify_receipt_v2",
    "AnyrouteMeta",
    "APIResponse",
    "Batch",
    "BatchResults",
    "ChatCompletion",
    "DataList",
    "Embeddings",
    "Model",
    "Rerank",
]
