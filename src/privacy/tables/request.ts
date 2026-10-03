import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, KEPT, rv } from "./common.ts";

// Request records: one row per call. These are the tables a reader should look at first: none has a column for the text of a
// prompt or an answer. What each call leaves is a generation row, a health row and, when the caller sent them, an app row.

export const requestTables: Record<string, TableDoc> = {
  batches: {
    category: "request",
    purpose:
      "One row per batch sent to the Batch API (POST /api/v1/batches): the key that sent it, its status, how many lines it has and how many succeeded or failed, and what it cost. The requests and answers of its lines are never written to the database: they are kept sealed in Redis or the router's memory (see the Redis section) until the batch's results expire.",
    request: "aggregate",
    retention: "No automatic deletion of the row itself; when the batch's results expire (results_expire_at), its line rows and its sealed requests and answers are deleted and purged_at is set.",
    columns: {
      id: "The batch id (batch_ and random hex).",
      account_id: "The account the batch's lines are billed to.",
      key_hash: "The hash of the API key that sent the batch; only that key can read or cancel it.",
      api: "Which API every line calls: chat or embeddings.",
      status: "validating, in_progress, cancelling, completed, failed, expired or cancelled.",
      total: "How many lines the batch has.",
      completed: { purpose: "How many lines succeeded.", request: "aggregate" },
      failed: { purpose: "How many lines failed.", request: "aggregate" },
      cost: { purpose: "What the batch's lines were charged, after the batch discount, in pico-USD.", request: "aggregate" },
      list_cost: { purpose: "What the same calls would have cost without the batch discount, in pico-USD.", request: "aggregate" },
      discount_bps: "The batch discount in basis points (BATCH_DISCOUNT_BPS when the batch was sent; 5000 is half price).",
      created_at: CREATED,
      started_at: "When the worker started the batch.",
      cancelling_at: "When the key asked to cancel the batch.",
      finished_at: "When the batch's last line ended.",
      expires_at: "The end of the 24-hour completion window: lines not run by then end unrun and unbilled.",
      results_expire_at: "When the batch's answers and line rows are deleted (finished_at plus BATCH_RESULTS_TTL).",
      purged_at: "When they were deleted.",
    },
  },

  batch_lines: {
    category: "request",
    purpose:
      "One row per line of a batch: its status, the HTTP status its call returned, the generation (and so the signed receipt) it produced and what it was charged. No request or answer text: that is sealed outside the database.",
    request: "yes",
    retention: "Deleted with the batch's sealed answers when its results expire (BATCH_RESULTS_TTL after the batch finished, 24 hours unless the operator changed it).",
    columns: {
      batch_id: "The batch the line belongs to.",
      idx: "The line's position in the batch, from 0.",
      api: "chat or embeddings.",
      status: "queued, running, succeeded, failed, cancelled or expired.",
      attempts: "How many times the worker started the line (a line whose providers were all unavailable is tried again, up to BATCH_LINE_MAX_ATTEMPTS).",
      status_code: "The HTTP status the line's call returned.",
      generation_id: "The generation the line produced, whose receipt it has.",
      cost: "What the line was charged, after the batch discount, in pico-USD.",
      list_cost: "What the line would have cost without the discount, in pico-USD.",
      failure_code: "For a line that did not succeed, the error type (for example insufficient_credits or batch_cancelled). A fixed code, never text from a request.",
      not_before: "The earliest the line runs (a rate-limited line waits), or, while it runs, when it counts as interrupted.",
      finished_at: "When the line ended.",
    },
  },

  generations: {
    category: "request",
    purpose:
      "One row per call the router served: who was billed, which model and provider answered, token counts, cost, timing, how it was paid and the signed receipt. It holds hashes of the request and the response, never their text.",
    request: "yes",
    retention: `${KEPT} Rows are read back for receipts, usage history, settlement and provider scoring.`,
    columns: {
      id: "Generation id, random. It is also the id of the signed receipt (the X-Receipt-Id response header).",
      ts: "When the call was recorded.",
      key_hash: "SHA-256 of the API key that made the call (the key itself is never stored). Empty for wallet-paid and blind-token calls.",
      account_id: "The account that was billed. For a blind-token call it is the shared token pool, not a person.",
      model_id: "The catalogue model id that answered, such as author/slug.",
      provider_id: "The provider that served the call.",
      tokens_in: "Prompt tokens billed, as a count.",
      tokens_out: "Completion tokens billed, as a count.",
      reasoning_tokens: "Reasoning tokens billed, as a count.",
      cached_tokens: "Prompt tokens the provider served from its cache, as a count.",
      cache_write_tokens: "Prompt tokens written to the provider's cache, as a count.",
      cost: "Total charged to the caller, in pico-USD (1e-12 USD).",
      upstream_cost: "What the provider charged the router for the call, in pico-USD.",
      royalty: "The share of the cost owed to the model's creator, in pico-USD.",
      margin: "The router's fee on the call, in pico-USD.",
      cache_discount: "The discount given for cached prompt tokens, in pico-USD.",
      mode: "How the call was paid: prepaid, per_call, paywith, byok, cache or blind.",
      latency_ms: "Milliseconds until the provider's first response.",
      generation_time_ms: "Milliseconds for the whole call.",
      finish_reason: "Why the model stopped, such as stop or length.",
      native_finish_reason: "The stop reason as the provider reported it.",
      streamed: "Whether the answer was streamed.",
      cancelled: "Whether the caller cancelled before the answer finished.",
      quant: "Quantisation of the endpoint that answered (for example fp8), or unknown.",
      data_region: "The first datacenter region the provider lists, not the caller's location.",
      is_byok: "Whether the caller's own provider key paid for the call.",
      private: "Whether the caller asked for a private route (provider.private or a :private model).",
      attestation_hash: "Hash of the attestation report of the provider, when an attested provider served the call.",
      receipt_id: "The receipt's id (the same as id).",
      receipt_sig: "The router's Ed25519 signature over the receipt.",
      receipt_key_id: "Which receipt signing key signed it.",
      receipt: {
        purpose:
          "The signed v1 receipt payload: model, provider, token counts, cost, timing, mode, lane, disclosure class, payer (a key hash or a wallet address), the two SHA-256 digests and a summary of the provider's attestation. Blind payment adds a single nullifier and issuer key id, or token_count, nullifiers and token_key_ids for a set; no buyer or credential bytes. The ciphertext chat adapter also signs end_to_end_encrypted and e2ee: version, suite, gateway_attested, complete, billing_basis, input_byte_bound, max_tokens, request_bytes, response_bytes and gateway_receipt with id, keyset digest, response-hash, request-hash and upstream verification state plus upstream session id and GPU claim. Request-hash verification remains false in the router. No public keys, replay nonces, credentials or content are retained. When ROUTE_EXPLAIN_ENABLED is true, route stores version, serving provider id, selection reason, eligible count, aggregate skip and fallback error-class counts, lane, required parameter names from a fixed allowlist and whether the provider is a network host. No other provider ids, weights, URLs, messages or content are added. With DECISION_TAGS_ENABLED, decision_tag stores the caller's X-Anyroute-Decision-Tag: a validated sha256 digest the caller computed, never what it was computed from. Fixed fields chosen by the router.",
        review: JSON_FIELDS("Every field is set by the router's receipt code from numbers, ids and hashes; it never copies request or answer text into the payload."),
      },
      receipt_leaf: "This receipt's leaf hash in the anchoring tree.",
      anchor_index: "Which anchor (Merkle root) this receipt was included in, once anchored.",
      leaf_index: "The receipt's position in that anchor tree.",
      receipt_v2: {
        purpose: "The v2 receipt claims as JSON: model, provider, lane, hashed request and response, power-of-two token-count buckets and cost units. The optional route claim carries the same versioned selection summary as v1, without other provider ids, raw errors or weights. The optional decision_tag claim is the same caller-computed sha256 digest as v1. Null for receipts made before v2.",
        review: JSON_FIELDS("Built by buildClaimsV2 from ids, hashes and buckets; the claims carry no payer, address, IP or content."),
      },
      receipt_cose: "The v2 receipt as signed COSE_Sign1 bytes, base64.",
      receipt_leaf_v2: "The v2 receipt's leaf hash in the anchoring tree.",
      leaf_index_v2: "The v2 leaf's position in the anchor tree.",
      paid_with: {
        purpose: "For a pay-with call: the token symbol and address, raw units accrued, the fair price used and the swap transaction, when there is one.",
        review: JSON_FIELDS("Written by the pay-with code from token symbols, addresses and amounts."),
      },
      payment_tx: "For a per-call payment: the transaction hash that paid.",
      app_id: "Links to the apps row when the caller sent HTTP-Referer or X-Title. Not recorded for the unlinkable lane.",
      attempts: {
        purpose:
          "Every provider the router tried for the call: provider, model, whether it worked, error kind, HTTP status and latency. A failed attempt also keeps up to 200 characters of the provider's own error message, with URLs, keys, emails and long hex removed.",
        review: rv(
          ["type:json"],
          "may-hold-fragment",
          "The failure message is the provider's text, not ours. Providers normally send a generic reason, but a provider could quote part of a rejected request in it, so up to 200 characters of request text could end up here.",
        ),
      },
      request_sha256: {
        purpose: "Ordinary chat: SHA-256 of canonical request JSON (stream flags excluded). The E2EE adapter hashes the exact forwarded encrypted envelope bytes, including whitespace and stream flags. Someone who already has the exact request can check it against this; the text cannot be recovered from it.",
        review: rv(["name:content"], "digest-only", "A hash of the request, kept so a receipt can be checked against a request the caller holds; it is 64 hex characters and holds no text."),
      },
      response_sha256: {
        purpose: "Ordinary chat: SHA-256 of response text (all choices joined). The E2EE adapter hashes encrypted JSON or SSE wire bytes, including framing; an interrupted response hashes the observed prefix. The text cannot be recovered from it.",
        review: rv(["name:content"], "digest-only", "A hash of the answer, kept for the receipt; it is 64 hex characters and holds no text."),
      },
      settled_period: "The UTC hour in which the call was settled to the provider, for example 2026-09-26T13.",
    },
  },

  health: {
    category: "request",
    purpose:
      "One row per provider attempt (and per probe): did it work, how fast, which status. It feeds routing and provider scores. It has no request or answer text and no account id.",
    request: "yes",
    retention: KEPT,
    columns: {
      model_id: "The model that was tried.",
      provider_id: "The provider that was tried.",
      ts: "When the attempt finished.",
      ok: "Whether the attempt produced a usable answer.",
      latency_ms: "Milliseconds until the first response.",
      tps: "Output tokens per second, when it could be measured.",
      empty200: "Whether the provider answered 200 with an empty completion.",
      status_code: "The HTTP status the provider returned, when there was one.",
      error_kind: {
        purpose: "A fixed code for the failure from the router's ErrorKind list, such as http_5xx, rate_limited, provider_auth, rejected, empty200 or interrupted. Null when the attempt worked.",
        review: rv(["name:content"], "no-request-content", "One of a short list of codes chosen by the router (ErrorKind); the provider's message is not stored here."),
      },
      source: "traffic for a real call, probe for the router's own health probe.",
      caller: "A 16-character truncation of the SHA-256 of the account id, set only on failed attempts, so one caller cannot single-handedly mark a provider as failing. It is not the account id.",
    },
  },

  apps: {
    category: "request",
    purpose: "Where calls come from, for app rankings: the HTTP-Referer and X-Title headers a caller chose to send, kept as the caller wrote them (truncated). Not recorded for the unlinkable lane.",
    request: "yes",
    retention: KEPT,
    columns: {
      id: "First 24 hex characters of SHA-256 of the referer and title, so the same app maps to one row.",
      url: {
        purpose: "The HTTP-Referer header value, cut to 500 characters. It is whatever the calling application sent, usually its own site address.",
        review: rv(["name:network"], "request-header", "A request header kept on purpose so apps can be ranked. It names an application's site, not the caller's network address, and callers can omit it."),
      },
      title: {
        purpose: "The X-Title header value, cut to 200 characters: the application's display name.",
        review: rv(["name:content"], "request-header", "A request header kept on purpose for app rankings. It is a short label the caller chooses, not a prompt."),
      },
      created_at: CREATED,
    },
  },
};
