import type { TableDoc } from "../types.ts";
import { CREATED, KEPT, KEPT_APPEND, rv } from "./common.ts";

// Keys and auth: API keys (kept only as hashes), the teams and sessions built on them, the provider keys you may bring, and the
// issuer and gateway keys behind blind tokens and Oblivious HTTP.

export const keyTables: Record<string, TableDoc> = {
  keys: {
    category: "keys",
    purpose: "One row per API key. The secret is never stored: the row holds its SHA-256 and a masked label. It also holds the key's limits, budget and spend.",
    request: "no",
    retention: "Deleting a key only disables it (DELETE /api/v1/keys/:hash sets disabled); the row stays because generations and balances refer to it.",
    columns: {
      key_hash: "SHA-256 of the key's secret. The secret itself is never stored.",
      chain_key_hash: "keccak256 of the address derived from the secret, the id the on-chain contracts use for the key.",
      key_address: {
        purpose: "The blockchain address derived from the key's secret. It is public on chain when the key is funded.",
        review: rv(["name:network"], "wallet-address", "A blockchain address derived from the key, not a network address of a caller."),
      },
      account_id: "The account the key belongs to.",
      parent_hash: "For a key made from another key (an agent session), the parent's key hash.",
      name: "The label the owner gave the key.",
      label: "A masked display form of the key, such as sk-ar-v1-abcd...wxyz: the first and last few characters only.",
      budget: "The key's spend limit in pico-USD. Empty means unlimited.",
      budget_reset: "How often the budget resets: daily, weekly or monthly, or never.",
      period_start: "When the current budget period began.",
      spent: { purpose: "Spend in the current budget period, in pico-USD.", request: "aggregate" },
      spent_total: { purpose: "All-time spend of the key, in pico-USD.", request: "aggregate" },
      rpm: "Requests-per-minute limit for the key.",
      tpm: "Tokens-per-minute limit for the key.",
      team_id: "The team the key belongs to, when it has one.",
      allowed_models: "If set, the only models the key may call.",
      pay_with_default: "The Stock Token symbol the key pays with by default.",
      scope: "Null keeps account access; inference permits model calls and this key’s own generation and receipt reads only.", // ZK6
      include_byok_in_limit: "Stored compatibility selection. Provider-side BYOK expenditure is not tracked; usage counts router-billed charges once.", // ZK6
      management: "Whether the key may manage other keys.",
      routing: {
        purpose: "Imported routing presets: model aliases and default provider preferences the owner set for this key.",
        review: rv(["type:json"], "config", "Routing settings written by the key's owner and validated as aliases and provider preferences; there is no field for message text."),
      },
      guardrails: {
        purpose: "The key's input guardrails: PII mode, phrases to block, a maximum input length and whether to redact output.",
        review: rv(["type:json"], "config", "The owner's filter settings. Deny phrases are words the owner wants blocked (up to 50 of 200 characters); they are rules, not requests."),
      },
      tracing: {
        purpose: "Where the key's owner asked for traces of this key's public-lane calls to go (their own OpenTelemetry collector, Langfuse or Helicone), and whether to include prompt and completion text. The destination URL and credentials are AES-256-GCM encrypted with APP_SECRET and never returned by the API.",
        review: rv(["type:json"], "config", "Destination settings written by the key's owner: a type, flags, a masked host, header names and one sealed string. The schema has no field for message text; content is only ever sent to the owner's destination, never stored here."),
      },
      disabled: "Whether the key is turned off.",
      expires_at: "When the key stops working, if it expires.",
      created_at: CREATED,
      last_used: { purpose: "When the key last made a call.", request: "yes" },
    },
  },

  byok_keys: {
    category: "keys",
    purpose: "A provider API key an account brought so calls to that provider use its own account there. Stored encrypted; only the router can decrypt it, to make calls for that account.",
    request: "no",
    retention: "Kept until the owner deletes it (DELETE /api/v1/byok/:provider removes the row).",
    columns: {
      id: "Row number, counting up from 1.",
      account_id: "The account that brought the key.",
      provider_id: "The provider the key is for.",
      key_enc: "The provider key, AES-256-GCM encrypted with the router's APP_SECRET.",
      label: "A masked label so the owner can tell keys apart.",
      created_at: CREATED,
    },
  },

  teams: {
    category: "keys",
    purpose: "A team, also called an organisation: a named group of keys under one owning account, optionally bound to a wallet or a Safe, with an optional org budget.",
    request: "no",
    retention: KEPT,
    columns: {
      id: "Team id.",
      name: "The team's name, chosen by its owner.",
      owner_account: "The account that owns the team.",
      owner_address: {
        purpose: "The wallet or Safe that owns the team, once it signed a one-time message (checked by recovery for a wallet, by EIP-1271 isValidSignature for a contract wallet). Empty until one is bound.",
        review: rv(["name:network"], "wallet-address", "A blockchain address the owner chose to bind, not a network address of a caller."),
      },
      owner_kind: "account (no wallet bound), eoa (a wallet) or contract (a Safe or another smart wallet).",
      owner_verified_at: "When the owner's wallet signature was checked.",
      budget: "The org budget in pico-USD: a cap on the sum of the limits of the team's keys. Empty means no cap.",
      created_at: CREATED,
    },
  },

  team_members: {
    category: "keys",
    purpose: "Which keys are in which team and their role.",
    request: "no",
    retention: KEPT,
    columns: {
      team_id: "The team.",
      key_hash: "The member key's hash.",
      role: "owner, admin, dev, viewer or agent (member is the older default).",
      principal_id: "For a key issued when a member signed in with a passkey or wallet, that member (team_principals.id).",
      created_at: CREATED,
    },
  },

  team_principals: {
    category: "keys",
    purpose:
      "Members of a team who sign in without an API key: a passkey (WebAuthn) or a wallet. There is no email, name or device information: a passkey row holds only its credential id and public key (attestation is not requested), a wallet row only its address.",
    request: "no",
    retention: "Kept while the team exists; revoking a member disables the row and the keys issued to it.",
    columns: {
      id: "Member id (tp_...).",
      team_id: "The team.",
      kind: "passkey or wallet.",
      subject: "For a passkey, its credential id (random bytes the authenticator chose, base64url); for a wallet, its address.",
      public_key: "The passkey's public key (COSE, base64url). It can check signatures, not make them.",
      alg: "The passkey's signature algorithm: -7 ES256, -8 EdDSA or -257 RS256.",
      sign_count: "The passkey's signature counter, so a cloned authenticator is noticed.",
      role: "The member's role: owner (the bound owner wallet), admin, dev or viewer.",
      disabled: "Whether the member was revoked.",
      created_at: CREATED,
      last_used: "When the member last signed in.",
    },
  },

  team_audit: {
    category: "keys",
    purpose:
      "A team's audit log: who changed members, keys, budgets, presets, routes and lane settings, and when. Each entry is hash-chained to the one before it, so an export can be checked offline (scripts/verify-audit.mjs). It records settings changes only, never what anyone asked a model.",
    request: "no",
    retention: `${KEPT_APPEND} A database trigger rejects UPDATE and DELETE.`,
    columns: {
      team_id: "The team.",
      seq: "The entry's position in the team's chain: 1, 2, 3, ...",
      at: "When the change was made.",
      actor: "Who made it: key:<first 16 hex digits of the key hash>, passkey:<member id> or wallet:<address>.",
      action: "What changed, such as member.join, key.create, budget.set, preset.save or route.update.",
      target: "What it changed: a key hash, member id, invite hash prefix, preset or route name.",
      detail: {
        purpose: "A few fixed fields about the change: a role, a limit, a lane, a version and hash, the names of the fields that changed.",
        review: rv(["type:json"], "config", "Fields chosen by the router for each action (src/teams/audit.ts, src/api/teams.ts): no free text from a call, and for presets only the version, hash and lane, never the system prompt."),
      },
      prev_hash: "The previous entry's hash (64 zeros for the first entry).",
      hash: "sha256(prev_hash bytes || canonical JSON of the entry).",
    },
  },

  agent_sessions: {
    category: "keys",
    purpose: "A short-lived sub-key for one agent run, with its own budget and expiry, so an agent's spending can be capped and ended.",
    request: "no",
    retention: "Ended sessions keep their row; a session ends at its expiry, when its budget is spent or when its owner ends it.",
    columns: {
      id: "Session id.",
      account_id: "The account the session belongs to.",
      parent_key_hash: "The key that created the session.",
      key_hash: "The session's own key hash (a row in keys).",
      name: "A label the creator gave the session.",
      budget: "The session's spend cap in pico-USD; empty means only the parent key's limits apply.",
      expires_at: "When the session ends by itself.",
      ended_at: "When it ended.",
      end_reason: "ended, expired or budget.",
      metadata: {
        purpose: "Labels the creator attached to the session: up to 32 short string, number or boolean values, 2 KB in all.",
        review: rv(["type:json"], "config", "checkMetadata refuses key names that look like prompt or completion text (such as prompt or messages), at most 32 keys, string values of at most 256 characters and 2,048 bytes in all. It cannot judge what a creator types into a value, so the text is whatever the creator wrote."),
      },
      created_at: CREATED,
    },
  },

  blind_keys: {
    category: "keys",
    purpose: "Issuer keys for blind tokens (Privacy Pass): one per epoch and denomination. Nothing here links a buyer to a token.",
    request: "no",
    retention: "The private half is wiped when the epoch stops issuing; the public half stays so old tokens remain verifiable.",
    columns: {
      key_id: "The token key id: hex SHA-256 of the RFC 9578 public key info.",
      epoch: "The epoch the key issues in.",
      denomination: "Token units a token from this key is worth.",
      unit_price: "Pico-USD per token unit, fixed when the key is made.",
      spki: "The public key, base64url.",
      private_enc: "The private key, AES-GCM encrypted with APP_SECRET. Null once the key no longer issues.",
      valid_from: "When the key started.",
      issue_until: "When it stops signing new tokens.",
      redeem_until: "When tokens from it stop being accepted.",
      revoked_at: "When it was revoked, if it was.",
      issued: "How many tokens were signed: a count and nothing else.",
      created_at: CREATED,
    },
  },

  blind_nullifiers: {
    category: "keys",
    purpose: "Spent blind tokens, one row per token including each member of a request set reserved atomically. A row holds the SHA-256 of a token so it cannot be spent twice; the issuer cannot connect that hash to the blinded request it signed.",
    request: "yes",
    retention: "A reservation is deleted if the request fails before anything is served; spent rows are kept so a token cannot be replayed.",
    columns: {
      nullifier: "SHA-256 of the token.",
      key_id: "The issuer key that signed it.",
      status: "reserved while a request runs, spent once served.",
      reserved_at: "When the token was reserved.",
      spent_at: "When the request it paid for was served.",
      generation_id: "The generation the token paid for; all members of a set share it, linking those redeemed tokens to the same request but never to a purchase.",
    },
  },

  ohttp_keys: {
    category: "keys",
    purpose: "Oblivious HTTP gateway keys, one per epoch. Their public halves are published; each private half is destroyed when its epoch's window ends.",
    request: "no",
    retention: "The private half is destroyed when the epoch's acceptance window ends, after which recorded traffic for that epoch can no longer be opened. The public half stays.",
    columns: {
      epoch: "The key's epoch.",
      key_id: "The 8-bit key identifier of the key configuration (epoch mod 256).",
      kem_id: "The HPKE KEM identifier.",
      public_key: "The public key, base64url.",
      config: "The encoded key configuration (RFC 9458), base64url.",
      config_sha256: "SHA-256 of that configuration.",
      private_enc: "The private key, AES-GCM encrypted with APP_SECRET. Null once destroyed.",
      valid_from: "When the key starts to be used.",
      accept_until: "Requests to this key are opened until here.",
      revoked_at: "When it was revoked, if it was.",
      created_at: CREATED,
    },
  },
};

