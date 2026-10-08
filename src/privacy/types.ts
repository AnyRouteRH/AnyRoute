// The shapes of the data inventory (src/privacy/inventory.ts): a description of everything the router stores, written next to
// the code, checked against the real schema by tests, and published as the "What we keep" page.

export const CATEGORIES = ["request", "billing", "receipts", "keys", "providers", "chain", "operations"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_INFO: Record<Category, { label: string; summary: string }> = {
  request: { label: "Request records", summary: "Ordinary call rows hold the model, provider, token counts, cost and timing, without the text. Owner-chosen scheduled run replies are also described here and stored encrypted at rest." },
  billing: { label: "Billing", summary: "Balances, the append-only ledger, spending holds, per-call payment quotes and what providers are owed." },
  receipts: { label: "Receipts & proofs", summary: "Signing keys, anchors and the transparency log that let anyone check a receipt without asking us." },
  keys: { label: "Keys & auth", summary: "API keys (stored as hashes), teams with their passkey and wallet members and audit log, agent sessions, keys you bring, and the issuer and gateway keys behind blind tokens and Oblivious HTTP." },
  providers: { label: "Providers & attestation", summary: "The provider registry and model catalogue, attestation results, measurements, disclosure profiles and the day-zero model lane." },
  chain: { label: "Chain", summary: "Blockchain events the router has read, escrow deposits, pay-with sessions and swaps, provider payouts and slashes." },
  operations: { label: "Operations", summary: "Settings you save (routes, presets, spend alerts) and the router's own key-value state." },
};

/** Whether a value is recorded per user request. "aggregate" means it is summed or derived from requests. */
export type AboutRequest = "yes" | "aggregate" | "no";
export const ABOUT_REQUEST_LABEL: Record<AboutRequest, string> = { yes: "Per request", aggregate: "Summed from requests", no: "Not about requests" };

/** What a reviewer decided about a column that looks like request content or a network address (see rules.ts). */
export const VERDICTS = [
  "no-request-content", // cannot hold request or answer text: a number, a flag, a hash, a fixed code or a public identifier
  "digest-only", // a hash or digest of content, never the content
  "wallet-address", // a blockchain wallet or contract address, not a network address
  "config", // configuration text or JSON written by the operator or the account owner and validated against a schema that excludes prompts
  "public-reference", // a URL or identifier of a public resource (a provider endpoint, a log entry), not of a caller
  "request-header", // a header value taken from the request, kept as written (truncated)
  "may-hold-fragment", // can hold a short fragment of request text that came back in a provider error message
  "holds-request-text", // stores prompt or answer text
  "network-address", // stores a client network address
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** An explicit review of a column the rules flagged. `covers` must list exactly the flags the rules raise for the column. */
export type Review = { covers: string[]; verdict: Verdict; why: string };

export type ColumnDoc = string | { purpose: string; request?: AboutRequest; retention?: string; review?: Review };

export type TableDoc = {
  category: Category;
  purpose: string;
  /** Default for the table's columns; a column can override it. */
  request: AboutRequest;
  retention: string;
  /** Extra lines shown under the table (for example the key families of a general key-value table). */
  notes?: string[];
  columns: Record<string, ColumnDoc>;
};

/** A place in the source that shows a statement is true. The test suite checks that the file exists and still contains `contains`. */
export type Evidence = { file: string; contains: string; note?: string };

/** One family of Redis keys (or, without Redis, the same keys in the router's memory). */
export type RedisFamily = {
  /** The key as stored, with the parts that vary in angle brackets. */
  key: string;
  purpose: string;
  /** What varies in the key: `address` means the caller's network address is part of the key. */
  holds: "address" | "key-hash" | "account" | "wallet" | "telegram-user" | "model" | "digest" | "nothing-personal";
  /** For a rate limit: the literal prefix passed to the limiter, so tests can match it to the call sites. */
  limiterPrefix?: string;
  windowSeconds?: number;
  /** Seconds the key lives, or a sentence when it depends on the request. */
  ttl: string;
  /** Set when the key holds (sealed) request or answer text. */
  requestText?: "answer-text" | "request-and-answer-text";
  evidence: Evidence[];
};

/** A place in the code where a request's text, or a caller's network address, is read. */
export type Touchpoint = {
  file: string;
  /** What is read there. */
  reads: string;
  /** What happens to it. */
  then: string;
  /** Whether anything derived from it is written anywhere durable. */
  kept: string;
  evidence: Evidence[];
};

export type ExternalDoc = {
  redis: {
    summary: string;
    /** Redis is optional in development and required in production. */
    families: RedisFamily[];
    memoryFallback: { purpose: string; ttl: string; evidence: Evidence[] };
  };
  logs: {
    summary: string;
    format: string;
    /** What a log line can carry. */
    records: string[];
    /** What no log call passes. */
    neverRecords: { item: string; evidence: Evidence[] }[];
    /** Exactly where text that we do not control can reach a log line. */
    caveats: string[];
    retention: string;
    evidence: Evidence[];
  };
  otherStores: { id: string; name: string; purpose: string; holds: string; ttl: string; requestText: "none" | "answer-text" | "request-and-answer-text" | "hashes"; evidence: Evidence[] }[];
  /** Everything that reads the network address of the caller. */
  addressReaders: Touchpoint[];
  /** Everything that reads the body of a request. Routes that read a body but touch no prompt say so. */
  bodyReaders: (Touchpoint & { carries: "prompt-or-answer" | "settings" | "payment-or-signature" | "public-data" })[];
  /** Where the caller's browser keeps things, which never reach us. */
  browser: { summary: string; items: { store: string; holds: string; evidence: Evidence[] }[] };
};
