/** One line of a verification report. `not_checked` is never a pass: it means this client did not look. */
export type CheckStatus = "pass" | "fail" | "not_checked";
export type Check = { id: string; status: CheckStatus; detail: string };

export type AnchorProof = { root: string; proof: string[]; index?: number; leaf_index?: number; status?: string; tx?: string | null; chain?: number; contract?: string | null };

/** The receipt envelope the router returns inline (`receipt`), from GET /api/v1/receipts/:id, and the sidecar sends. */
export type ReceiptEnvelope = {
  id?: string;
  payload: Record<string, unknown>;
  /** Base64 Ed25519 signature over the canonical JSON of `payload`. */
  sig: string;
  key_id: string;
  alg?: string;
  /** keccak256(keccak256(canonical payload || signature)): the leaf that is anchored. */
  leaf?: string;
  anchor?: AnchorProof | null;
  [extra: string]: unknown;
};

export type JwkKey = {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  use?: string;
  alg?: string;
  valid_from?: string;
  retired_at?: string | null;
  onchain_tx?: string | null;
};
export type KeySet = { keys: JwkKey[] };

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
