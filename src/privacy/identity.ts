import type { Evidence, ExternalDoc, RedisFamily, TableDoc } from "./types.ts";
import { rv, JSON_FIELDS } from "./tables/common.ts";

// v6 I: receipt-backed identity and reputation (src/identity). AGENT_IDENTITY_ENABLED and PAID_FEEDBACK_ENABLED default
// to false; with both off no route answers, no job runs and these tables stay empty.

const ev = (file: string, contains: string): Evidence => ({ file, contains });

export const identityTables: Record<string, TableDoc> = {
  agent_identities: {
    category: "keys", request: "no",
    purpose: "Per agent key: the owner's identity opt-out and reputation opt-in, and the progress of an ERC-8004 identity registration the owner asked for.",
    retention: "Until the key is deleted (cascade). Opting out keeps the row so the choice persists. A registration sent to the chain is public and permanent there; deleting this row does not remove it.",
    notes: ["The ERC-8004 identity registry is a public contract the router does not operate. The registration file it points to is served only while the key has not opted out and contains owner-written profile fields and router links, never the key hash or account. Keys whose rulebook allows only the unlinkable lane are opted out unless the owner opts in."],
    columns: {
      key_hash: "The agent key these choices belong to; never published.",
      id: "Random 144-bit public id used in the registration file URL; independent of the key hash and the profile slug.",
      identity_opt_out: "Owner's choice; null means the default (opted out only when the key's rulebook allows only the unlinkable lane).",
      reputation_opt_in: "Owner's choice to accept paid feedback; false by default.",
      status: "Fixed registration state: none, awaiting_owner, queued, submitted, registered or failed.",
      mode: "owner (the owner's wallet sends the transaction) or registrar (the isolated worker sends it).",
      registry: "Public registry identifier eip155:<chain id>:<contract address>.",
      agent_id: "The public ERC-8004 agent id read from the registration transaction.",
      owner_address: { purpose: "The wallet that holds the identity token, read from the public registration event.", review: rv(["name:network"], "wallet-address", "A blockchain wallet address from a public on-chain event, not a network address; it is shown to the owner only.") },
      tx_hash: "The public registration transaction hash.",
      error: { purpose: "Fixed failure code of the last registration attempt.", review: rv(["name:content"], "no-request-content", "Only fixed codes written by the router (reverted, no_registration, uri_mismatch, send_failed); never library text, a request or an answer.") },
      updated_at: "When the row last changed.",
    },
  },
  agent_feedback: {
    category: "keys", request: "no",
    purpose: "Paid feedback: a 0 to 100 score and up to two short tags per receipt, accepted only from the receipt's payer about its payee or the agent it served.",
    retention: "Until the subject key is deleted (cascade). A reviewer can withdraw an entry, which stops counting it; the row is kept with its withdrawal time. No automatic deletion.",
    notes: ["Public: the score, tags, receipt kind, a coarse payment band and the payment day, linked to the agent's public profile slug. Never public: the reviewer's account, the receipt id and the exact amount. One entry per receipt."],
    columns: {
      id: "Random public feedback id.",
      subject_key_hash: "The reviewed agent's key; never published.",
      reviewer_account_id: "The paying account, kept to enforce one entry per receipt and the reviewer's right to withdraw; never published.",
      receipt_kind: "Fixed receipt kind such as model.call or agreement.release.",
      receipt_id: "The router's own receipt or agreement milestone id that backs the entry; never published.",
      score: "Score from 0 to 100.",
      tag1: "Optional short tag (letters, digits, spaces and . _ : - only, up to 32 characters).",
      tag2: "Optional second short tag, same limits.",
      paid_pico: "What the reviewer paid on the receipt, net of recorded refunds, in pico-USD; used for weighting and shown only as a band.",
      paid_at: "When the payment happened; weights halve every PAID_FEEDBACK_HALF_LIFE_DAYS after it.",
      created_at: "When the entry was written.",
      revoked_at: "When the reviewer withdrew it; null while it counts.",
    },
  },
  agent_liveness: {
    category: "keys", request: "no",
    purpose: "The latest signed liveness probe of each listed agent's declared endpoint (daily agent-liveness job).",
    retention: "Replaced by each probe; deleted with the key (cascade). A result for an endpoint the owner has since changed is not shown.",
    columns: {
      key_hash: "The listed agent key; never published.",
      endpoint_sha256: { purpose: "SHA-256 of the probed endpoint URL, so a changed endpoint invalidates the old result.", review: rv(["name:network"], "digest-only", "A digest of the owner-declared public endpoint URL; never a caller's network address.") },
      live: "Whether the endpoint answered with a status below 500, other than 404 and 410, within the timeout.",
      http_status: "The status code the endpoint answered with; null when it did not answer.",
      latency_ms: "Time to the response headers in milliseconds.",
      error: { purpose: "Fixed failure code: timeout, network, blocked or http.", review: rv(["name:content"], "no-request-content", "Only fixed codes chosen by the router; no response body, header or library message is stored.") },
      probed_at: "When the probe ran.",
      receipt: { purpose: "The probe receipt the router signed with its receipt key: the public profile slug, endpoint digest, time, result, status and latency.", review: JSON_FIELDS("Fixed fields written by the router, signed with the published receipt key; no response body, headers or key hash.") },
    },
  },
  agent_track_records: {
    category: "receipts", request: "aggregate",
    purpose: "Portable track-record certificates: a router-signed count, total spend, refund and dispute rates of one key's anchored receipts, with a Merkle root over those receipts' anchor leaves.",
    retention: "Until the key is deleted (cascade). Certificates expire after seven days but stay stored; published ones show on the card until they expire.",
    columns: {
      id: "Random public certificate id.",
      key_hash: "The certified key; never published.",
      certificate: { purpose: "The signed certificate: random pseudonym, aggregate stats, Merkle root and anchor counts, the public profile slug and ERC-8004 agent id when registered.", review: JSON_FIELDS("Aggregates and hashes written by the router: no counterparty, no amount per counterparty, no request or answer text and no key hash.") },
      published: "Whether the owner chose to show it on the public card.",
      created_at: "When it was issued.",
      expires_at: "Seven days after issuance.",
    },
  },
};

export const feedbackLimit: RedisFamily = {
  key: "rl:agent-feedback:<account id>:<window start>",
  purpose: "Paid-feedback submissions, thirty per minute per reviewing account. Contains only the account id and a counter.",
  holds: "account",
  limiterPrefix: "agent-feedback:",
  windowSeconds: 60,
  ttl: "61 seconds (the 60-second window plus one second)",
  evidence: [ev("src/identity/routes.ts", "await ctx.limiter.take(`agent-feedback:${reviewer.accountId}`"), ev("src/lib/ratelimit.ts", "const k = `rl:${key}:${start}`;"), ev("src/lib/ratelimit.ts", "await this.redis.pexpire(k, windowMs + 1000);")],
};

export const identityBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/identity/routes.ts", carries: "settings",
  reads: "Owner identity choices (two booleans), a registration transaction hash, a publish flag for a track record; a reviewer's receipt id, receipt kind, 0 to 100 score and two short tags; or a track-record certificate to verify.",
  then: "Owner routes require an owner or administrator key of the same account, not a session key. Feedback is accepted only when the router's own receipt names the reviewer's account as payer and the agent as payee or the agent served, and never from the agent's own account. Free text is refused.",
  kept: "Choices and registration progress in agent_identities, entries in agent_feedback, issued certificates in agent_track_records. Verification keeps nothing. One new account rate-limit family (agent-feedback). No prompt, answer, caller address or log field.",
  evidence: [ev("src/identity/routes.ts", "settingsBody.parse(await readJson(c))"), ev("src/identity/routes.ts", "feedbackBody.parse(await readJson(c))")],
};

export const identityStores: ExternalDoc["otherStores"] = [
  {
    id: "agent-liveness-probes", name: "Liveness probes to listed agent endpoints",
    purpose: "When AGENT_IDENTITY_ENABLED is on, the agent-liveness job sends one GET a day to each listed profile's owner-declared HTTPS endpoint, to a public address only (no redirects, a ten-second timeout by default), with a fixed Anyroute-Liveness user agent and no credentials, and does not read the response body.",
    holds: "The status code, latency and a fixed failure code in agent_liveness with a signed probe receipt. The endpoint's operator sees the router's network address and the request.",
    ttl: "Each probe replaces the previous result. Nothing is kept in memory between runs.",
    requestText: "none",
    evidence: [ev("src/identity/liveness.ts", "redirect: \"error\", signal: AbortSignal.timeout(timeoutMs)"), ev("src/identity/liveness.ts", "await res.body?.cancel()")],
  },
  {
    id: "erc8004-registries", name: "ERC-8004 registries on Robinhood Chain",
    purpose: "An identity registration (owner-sent, or sent by the isolated registrar worker) writes a public, permanent record: the registration file URL, a metadata entry pointing at the router's receipt keys, and the holding wallet. Optional feedback and validation calldata the router prepares is sent only by the reviewer's or validator's own wallet.",
    holds: "Public chain data: agent ids, registration URLs, wallets, scores, tags and document hashes. No key hash, account id, receipt id or amount is placed in calldata the router prepares.",
    ttl: "Permanent on chain; opting out stops the router serving the registration file and links, but cannot remove a sent transaction.",
    requestText: "none",
    evidence: [ev("src/identity/erc8004.ts", "export function registerCall"), ev("src/identity/erc8004.ts", "export function giveFeedbackCall")],
  },
  {
    id: "track-record-trees", name: "Track-record Merkle trees in memory",
    purpose: "Proof requests rebuild a certificate's tree from the router's generation records and keep at most 32 trees in process memory.",
    holds: "Receipt anchor leaves (hashes) and generation ids of the certified key's counted receipts.",
    ttl: "Until evicted by newer trees or the process exits.",
    requestText: "hashes",
    evidence: [ev("src/identity/track-record.ts", "if (trees.size >= 32) trees.delete(trees.keys().next().value!);")],
  },
];
