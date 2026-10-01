CREATE TABLE "agent_profiles" (
	"slug" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"settings" jsonb NOT NULL,
	"certificates" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_key_uq" ON "agent_profiles" USING btree ("key_hash");