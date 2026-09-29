CREATE TABLE "attestation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"kind" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"reason" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"tee_kind" text,
	"attestation_hash" text,
	"tls_spki_sha256" text,
	"measurements" jsonb,
	"measurement_changed" boolean DEFAULT false NOT NULL,
	"verifiers" jsonb,
	"detail" jsonb
);
--> statement-breakpoint
CREATE INDEX "attestation_events_provider_ts_idx" ON "attestation_events" USING btree ("provider_id","ts","id");--> statement-breakpoint
CREATE INDEX "attestation_events_ts_idx" ON "attestation_events" USING btree ("ts");