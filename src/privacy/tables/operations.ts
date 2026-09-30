import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, UPDATED, rv } from "./common.ts";

// Operations: settings an account saves, and the router's own small key-value state.

export const operationTables: Record<string, TableDoc> = {
  saved_routes: {
    category: "operations",
    purpose: "A saved routing policy an account calls as @route/<slug>: ordered fallback models, provider preferences and default sampling settings. It cannot hold prompt or system-prompt text.",
    request: "no",
    retention: "Kept until the account deletes the route (DELETE /api/v1/routes/:slug).",
    columns: {
      id: "Route id.",
      account_id: "The account that owns it.",
      slug: "The name used in @route/<slug>.",
      name: "The route's display name, up to 80 characters.",
      description: {
        purpose: "A description written by the account, up to 280 characters.",
        review: rv(["name:content"], "config", "A label the owner types about the route (limited to 280 characters). It is a setting, not a request; the API cannot tell what an owner chooses to write."),
      },
      config: {
        purpose: "The route: models, provider preferences and a closed list of sampling controls (temperature, top_p, max_tokens, seed, stop sequences and similar).",
        review: rv(["type:json"], "config", "Validated by a strict schema (routeConfigSchema) that lists the allowed fields. There is no field for messages or system prompts; the only free text is up to four stop sequences of 32 characters."),
      },
      created_by: "The key that created it.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },

  spend_alerts: {
    category: "operations",
    purpose: "Alert rules on spend (threshold, share of a budget, anomaly), evaluated by the spend-watch job. They read spending totals, not requests.",
    request: "no",
    retention: "Kept until the account deletes the rule (DELETE /api/v1/spend/alerts/:id).",
    columns: {
      id: "Rule id.",
      account_id: "The account.",
      key_hash: "The key the rule watches; empty means the whole account.",
      kind: "threshold, budget_pct or anomaly.",
      window: "day, week or month.",
      threshold: "The spend threshold in pico-USD, for a threshold rule.",
      pct: "The budget percentage, for a budget_pct rule.",
      webhook_url_enc: {
        purpose: "The address alerts are posted to, if the owner set one. Stored encrypted with the router's APP_SECRET.",
        review: rv(["name:network"], "config", "A destination the account owner chose for alerts, stored only as ciphertext. It is not a caller's address."),
      },
      enabled: "Whether the rule is on.",
      last_fired_at: "When it last fired.",
      last_period: "The period it last fired for, so it fires at most once per period.",
      state: { purpose: "The rule's firing history and delivery status.", review: JSON_FIELDS("Firings and their delivery status written by the spend-watch job (period, amount, status, lease); it holds spend figures, never request content.") },
      created_by: "The key that created it.",
      created_at: CREATED,
    },
  },

  kv: {
    category: "operations",
    purpose: "The router's small key-value store: job status, cursors, cached facts about providers, pending sign-in challenges and Telegram bot state. No request or answer text is written here.",
    request: "no",
    retention:
      "Per key family: a wallet sign-in challenge is deleted when used and any older than 10 minutes is deleted when the next challenge is made; a Telegram user's row is deleted by /forget; other families are overwritten in place.",
    notes: [
      "telegram:offset, telegram:user:<Telegram user id>: the update cursor, and per user the API key sealed under APP_SECRET, the chosen model and the private-mode switch (services/telegram.ts). Message text is not stored.",
      "wallet-login:<nonce>: a sign-in challenge (wallet address, the router's own origin, chain id, expiry and the message to sign). Deleted when used; older ones are pruned.",
      "job-health:<job>, alerts:state, alerts:lease, backup:last: when each background job last ran, alert state, an alert lease and the time and checksum of the last database backup.",
      "tls-pin:<provider>, aci-gateway:<provider>, aci-gpu:<model>, attest-policy:<provider>, attest-allow:<provider>, static-models-pending:<provider>, apply-token:<application id>: facts about providers (pinned certificate keys, verified gateway keysets, operator allow-lists, a pending model list, and the SHA-256 of an application token).",
      "paywith-allowance:<chain key hash>, paywith-intent:<chain key hash>, paywith-commitment:<commitment>: a signed pay-with allowance (wallet address and signature), the wallet and token a key holder registered for pay-with, and the swap a usage commitment belongs to.",
      "escrow:checkpoints, spent_settled:<epoch>, margin_unsent, holder-credits-run:<period>:<time>, ipx-oracle:*: chain cursors and settlement bookkeeping.",
    ],
    columns: {
      key: "The key, a family name plus an identifier (see the families above).",
      value: {
        purpose: "The value, as JSON. Its shape depends on the key family.",
        review: rv(["type:json"], "no-request-content", "Each family is written by one piece of code from ids, hashes, timestamps, amounts and settings; the families are listed under the table. None takes a value from the body of a chat, embeddings or other inference request."),
      },
      updated_at: UPDATED,
    },
  },
};
