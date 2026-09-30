import type { TableDoc } from "../types.ts";
import { CREATED, KEPT, UPDATED, rv } from "./common.ts";

// Characters: Tavern cards a creator publishes, the creator attribution counters, and the client-sealed memory ledger.

export const characterTables: Record<string, TableDoc> = {
  characters: {
    category: "operations",
    purpose:
      "Character cards an account registers (Tavern Card v2 or v3). A public or unlisted card is text its creator publishes for others to use, kept as written. A private card is kept only as the ciphertext the owner's own device sealed, with the SHA-256 of the card; the router never receives its key or its text at rest.",
    request: "no",
    retention: "Kept until the owner deletes the character (DELETE /api/v1/characters/:id), which also deletes its attribution counters.",
    columns: {
      id: "Character id, used as @character/<id>.",
      account_id: "The account that owns it.",
      visibility: "public (listed in discovery), unlisted (readable by anyone with the id) or private (sealed, owner only).",
      name: "The card's name; empty for a private card.",
      tags: "The card's tags, lowercased, for discovery; empty for a private card.",
      creator: "The card's creator field as the card states it; empty for a private card.",
      spec: "chara_card_v2 or chara_card_v3; empty for a private card.",
      card: {
        purpose: "The normalized card of a public or unlisted character: name, description, personality, scenario, greetings, example dialogue, system prompt, post-history instructions, tags, creator notes and lorebook. Empty for a private card.",
        review: rv(
          ["type:json"],
          "config",
          "Written by the card's owner through POST or PUT /api/v1/characters and normalized to the Tavern card fields, at most 512 KB. It is text a creator publishes for others to use, not text taken from a call: chats with the character are not stored here or anywhere else, and a private card is never stored in this column.",
        ),
      },
      sealed_card: "A private card as the owner's device sealed it: AES-256-GCM ciphertext under a key the router never receives. Empty for a public or unlisted card.",
      card_hash: "SHA-256 of the card's canonical JSON. For a private card the router checks a card sent with a chat against it before using it.",
      default_model: "The model @character/<id> uses when a request names none.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },

  character_usage: {
    category: "operations",
    purpose: "Creator attribution for public characters: how many calls used each one and what they cost, summed per UTC day. It records no request, answer, key or caller.",
    request: "aggregate",
    retention: `${KEPT} Rows are deleted with their character.`,
    columns: {
      character_id: "The public character.",
      period: "The UTC day, YYYY-MM-DD.",
      calls: "Calls that used the character that day (never counted on the unlinkable lane).",
      cost: "What those calls cost in total, in pico-USD.",
    },
  },

  character_memory: {
    category: "operations",
    purpose:
      "Character memory an account keeps: rolling summaries, facts and lorebook notes sealed on the account's own device (AES-256-GCM) under a viewing key the router never receives. The router stores ciphertext, never the memory's text, and cannot tell which character a memory belongs to.",
    request: "no",
    retention: "Kept until the account deletes it (DELETE /api/v1/memory/:id, or ?scope= / ?all=1 for many).",
    columns: {
      id: "Memory id.",
      account_id: "The account that owns it.",
      scope: "An HMAC of the character id under the client's key: it groups one character's memories without naming the character.",
      kind: "summary, fact, lorebook or state, as the client labels it.",
      sealed: "The ciphertext the client sealed (arm1.<iv>.<ciphertext>); the API refuses anything that is not in this sealed form.",
      key_id: "A 16-hex fingerprint derived from the client's key, so the client can tell which key sealed it. The key cannot be recovered from it.",
      bytes: "Size of the ciphertext in characters.",
      embedding: {
        purpose:
          "Only when the client opts in (embedding_opt_in): a vector the client computed from the memory, for similarity search. It cannot be turned back into the text, but it can reveal what the memory is about, so it is off by default. Empty otherwise.",
      },
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },
};
