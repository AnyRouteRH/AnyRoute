# SEAL 0005: Measured policy

| | |
| :--- | :--- |
| Status | Draft |
| Version | 0.1.0 |
| Updated | 2026-09-29 |
| License | Apache-2.0 |
| Related | [0001](0001-attestation.md), [0004](0004-receipts.md) |

## Status of this document

This is a working draft of the SEAL protocol. It is not an IETF document. Sections marked **(implemented)** describe formats that exist in this repository and are frozen under their version string. Sections marked **(planned)** describe the target design and may change before 1.0.0.

## Abstract

SEAL serves models with minimal filtering to users whose content nobody outside the enclave can read. The only filtering is a small block list enforced inside the enclave by a pinned classifier. What that list is, and which classifier enforces it, is measured into the enclave's attestation, so a user can verify exactly what is enforced and that nothing else is. A block produces a signed refusal receipt that carries no content. This document defines the policy, its measurement, the refusal, and a dispute path that works without logs.

## 1. Conventions and terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

* **Policy**: the set of categories an enclave refuses, the classifier that decides, and how it is asked.
* **Policy hash**: the digest of the canonical policy, bound into the attestation and named in receipts.
* **Classifier**: a second model served inside the same enclave, with pinned weights.
* **Refusal receipt**: a receipt ([0004](0004-receipts.md)) for a request the policy refused.
* **Canonical JSON** and JCS are as in [0001](0001-attestation.md) Section 1.

## 2. Principles

1. **Measured.** The policy and the classifier's weights are hashed and bound into the attestation. A policy that is not measured MUST NOT be enforced.
2. **Minimal.** Categories that are illegal everywhere are built in and cannot be removed. Anything an operator adds is listed publicly and changes the policy hash.
3. **Nothing else.** An enclave MUST NOT filter, rewrite or log content outside the measured policy.
4. **Fail closed.** If the classifier cannot decide, the request is refused, never passed.
5. **No content out.** A refusal carries at most a category code, never the text. The operator has no interface that returns content, labels or categories.

## 3. Policy v1 (implemented)

### 3.1 Configuration and measurement

The in-enclave classifier is off unless the operator turns it on. When on:

* Its weights are hashed at boot like the main model's ([0001](0001-attestation.md) Section 4.1) and MUST be on a separate classifier allow-list; a digest on the model list does not qualify.
* The enforced categories are the built-in minimum followed by the operator's additions (`id`, one-line `description`). Today the built-in minimum is `minor_sexual_content`. There is no setting that removes or redefines a built-in category, and the enclave refuses a classifier that does not enforce them all.
* The policy hash is:

```
classifier_policy = "sha256:" || hex(SHA-256(canonical_json({
    "v": "anyroute-classifier-v1",
    "system_prompt": <the fixed prompt, built from the enforced categories>,
    "check_response": <bool>,
    "non_text_input": "refuse" | "allow"
})))
```

* `classifier_enabled: true`, `classifier_digest` and `classifier_policy` are added to the attestation bindings ([0001](0001-attestation.md) Section 3.1). `GET /attest` lists the categories from which the policy hash is derived, so a verifier can recompute it.

### 3.2 What is checked

Every request member that is not a plain setting is checked: message text and tool-call arguments, `prompt`, `input`, `system`, tool descriptions and schemas, stop strings and vendor extensions. Model names and sampling parameters are skipped. Long text is split into overlapping pieces, each checked with one chat-completions call to the classifier using a fixed prompt, with the text placed between unguessable boundary lines. The reply MUST be exactly one label, `SAFE` or a category id; anything else is treated as no decision.

Images, audio and files are not text and are not examined. By default a request that carries them is refused (`non_text_input: refuse`); `allow` lets them through, and that choice is part of the policy hash. With `check_response: true` the generated text is checked before release; a stream is then read to the end first, so a flagged stream is never partly sent.

### 3.3 Outcomes

| Outcome | Response | Receipt |
| :--- | :--- | :--- |
| Allowed | The model's answer | Normal receipt with `classifier: {enabled: true, digest, blocked: false}` |
| Blocked | 400 `content_policy_violation`, generic message, no category, no echo | Signed refusal receipt with `classifier.blocked: true`, `status: 400`, no usage |
| No decision (error, timeout, unreachable, unparseable label) | 503 `content_check_unavailable` | None: no decision was made |
| Too much text to check | 413 `content_too_large` | None |

A refused request still spends a unit of the caller's request quota, so the check cannot be probed for free. The enclave keeps counters only (blocked requests, blocked responses, unavailable). The text, the label and the category are not logged or stored.

## 4. Policy v2 (planned)

### 4.1 `policy.json`

The policy becomes a JCS-canonical document:

```json
{
  "version": "default-v1",
  "categories": ["csam", "terrorism_operational"],
  "classifier": { "model": "<repository id>", "sha256": "<weights digest>" },
  "thresholds": { },
  "action": "refuse",
  "images": false
}
```

`policy-hash = SHA-256(JCS(policy.json))` is extended into RTMR3 at boot ([0001](0001-attestation.md) Section 4.3) and carried in every receipt as `node.policy_hash`. An enclave whose policy hash is not on the manifest's `policy_hashes_allowed` list MUST refuse to boot. Version 1 of the policy is text only: no image inputs are accepted.

### 4.2 Streaming enforcement

The prompt is checked before generation. The output is checked as tokens stream, by a streaming classifier; on a block mid-stream the enclave truncates the response, ends the chunk chain ([0004](0004-receipts.md) Section 4.2) and emits a refusal receipt with `policy.blocked: true` and a category code only.

### 4.3 Telemetry

Counters inside the enclave (requests, blocks by category, latency and token buckets) are exported hourly with Laplace noise for differential privacy. There are no per-request logs, and the platform's public log and system-information endpoints are off.

## 5. Disputes without logs (planned)

Nobody but the client holds the plaintext, so a dispute starts with the client:

1. The client keeps its own plaintext and the refusal receipt.
2. It sends `POST /v1/dispute {rid, plaintext}` over the inner encrypted channel ([0002](0002-transport.md) Section 3) to a shadow enclave with the same attestation requirements.
3. The shadow enclave checks that the plaintext hashes to the receipt's `req.h`, re-runs the decision with a larger classifier at a stricter threshold, and signs a second verdict that names the original `rid`.
4. Both receipts are returned to the client only. No operator sees the content at any step.

## 6. Security considerations

* **Classifier error.** A small model is a backstop, not a guarantee. It has false negatives and false positives, and crafted text can try to talk it into `SAFE`. Telling the classifier to treat text as data helps and proves nothing.
* **Plaintext exposure.** The classifier server receives request text in the clear and MUST be reachable only from inside the enclave, on an internal network with no published ports.
* **Meaning of the hash.** The policy hash fixes what the classifier is asked and which weights answer. It does not prove how well they answer.
* **Side channels.** A refusal is observable by its status code and timing. Version 1 returns no category to limit what a refusal reveals; version 2 returns a category code only.
* **Measured at boot.** Weights and policy are measured once, at boot. They MUST be mounted read-only.
* **Not a compliance program.** The policy defines what the enclave refuses. It is not, by itself, a legal compliance program.

## 7. References

### Normative

* [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
* [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
* [RFC8785] Rundgren, A., Jordan, B., Erdtman, S., "JSON Canonicalization Scheme (JCS)", RFC 8785.

### Informative

* [RFC9052] Schaad, J., "CBOR Object Signing and Encryption (COSE): Structures and Process", RFC 9052.
* Dwork, C., McSherry, F., Nissim, K., Smith, A., "Calibrating Noise to Sensitivity in Private Data Analysis", TCC 2006.
* OpenDP, https://opendp.org.
