CREATE TABLE "account_linked_wallets" (
  "wallet" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL REFERENCES "accounts"("id"),
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_linked_wallets_wallet_check" CHECK ("wallet" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE INDEX "account_linked_wallets_account_idx" ON "account_linked_wallets" ("account_id");
