import type { TableDoc } from "../types.ts";
const json = (purpose: string) => ({ purpose, review: { covers: ["type:json"], verdict: "no-request-content" as const, why: "Contains only public HostBond event values or projections: wallet and contract identifiers, amounts, reason codes, hashes, flags and block times. No inference content or caller connection address is read." } });
const host = (purpose: string) => ({ purpose, review: { covers: ["name:network"], verdict: "no-request-content" as const, why: "A bytes32 contract host identifier, derived from the provider id with keccak256. It is not a caller connection address or a host's network endpoint." } });
const common = { category: "chain" as const, request: "no" as const, retention: "Kept until the operator removes the bond index. Orphaned journal events and projections are removed on a chain reorganization; slash intent and evidence commitments are retained for idempotency." };
export const hostBondTables: Record<string, TableDoc> = {
  host_bond_cursor: { ...common, purpose: "Resumable HostBond event scan cursor, isolated by chain and contract. Serializes scans and slash intents across workers.", columns: {
    scope: "Chain id and HostBond contract address; public chain identifiers.", block: "Last scanned canonical block, or the deployment block minus one before scanning.", block_hash: "Canonical block hash at the scan cursor.",
    checkpoints: json("Up to 128 scan endpoints as block number/hash pairs. Reorgs rewind to the newest matching checkpoint, or the deployment block when none remain canonical."),
    checked_at: "Last caught-up scan time. Zero during backfill; routing boosts and slashing stop after 120 seconds without a caught-up pass.",
  } },
  host_bond_events: { ...common, purpose: "Every decoded event from the configured HostBond deployment, including ownership and parameter changes. Reversible journal; no inference records are changed.", columns: {
    scope: "Chain id and HostBond contract address.", tx_hash: "Public transaction hash, unique with scope and log index.", log_index: "Log position within the canonical block.", block: "Canonical event block number.", block_hash: "Block hash checked against the RPC's canonical chain.", event: "ABI event name, including Bonded, UnbondRequested/Cancelled/Unbonded, slash lifecycle, role, ownership and minimum changes.",
    args: json("Decoded public ABI arguments: bytes32 host id/evidence root/dispute hash, slash id, operator/recipient/role wallets, amount, total, reason, cooldown/dispute deadline and delisting flag. Numbers are decimal strings; no arbitrary transaction calldata is stored."),
  } },
  host_bond_projection: { ...common, purpose: "Reversible HostBond state reduced from the journal, with one row per host, slash or parameter set. The provider's existing bond_usdg field is left unchanged.", columns: {
    scope: "Chain id and HostBond contract address.", kind: "Projection kind: host, slash or parameters.", id: "Bytes32 host id, decimal slash id, or the fixed current parameter key.",
    data: json("Host projections contain operator wallet, total and queued bond, unbond deadline and delisting flag. Slash projections contain host id, amount, contract reason, evidence root, dispute deadline/hash, status, approval generation and transaction history. Parameter projection contains minimum bond, approval generation, owner/pending owner, slasher and refund pool wallets. All values are public on-chain data."),
  } },
  host_slash_evidence: { ...common, request: "aggregate", purpose: "Hash-committed evidence of quote-bound host policy rejection and invalid receipts from the pinned host feed, plus durable proposal/execution intents. Disabled unless NETWORK_BONDS_ENABLED.", columns: {
    scope: "Chain id and HostBond contract address.", root: "0x-prefixed SHA-256 commitment of the exact canonical evidence bundle; primary key with scope prevents repeated proposal intents.", provider_id: "Network provider id from the registry.", host_id: host("keccak256 of the provider id, matched to the HostBond operator before proposal."),
    canonical: "Exact canonical structured bundle: format, provider/host ids, fault kind, contract reason or null, policy version/hash where applicable, observed binding or receipt digest, attestation reference, receipt public key when applicable, and rejection digest. Contains hashes and identifiers only. Raw quotes, bindings, receipt envelopes, signature bytes, prompt and answer text are not retained here. A commitment does not by itself prove fault; review requires the source evidence.",
    reason: "Contract MeasurementDrift code 0 for verified policy rejection; -1 means invalid receipt evidence awaiting policy review, never automatically proposed.",
    amount: "Proposal amount in USDG base units: current whole bond at preparation, or would-be amount in dry run. Owner independently approves the exact proposal.",
    status: "ready, review, dry_run, submitted, executing, cancelled or executed; always reconciled against the canonical journal before action.",
    proposal_tx: "Hash of the single persisted proposal transaction.", proposal_raw: "APP_SECRET-encrypted signed proposal transaction. Saved before broadcasting; retries reuse identical bytes and nonce. The signed transaction becomes public on broadcast; no slasher key is persisted.",
    execution_tx: "Hash of the single persisted execution transaction.", execution_raw: "APP_SECRET-encrypted signed execution transaction, saved before broadcast and reused on retry. Independent owner approval and the undisputed window are checked before preparation.",
    created_at: "Time this exact evidence commitment was first stored.",
  } },
};
