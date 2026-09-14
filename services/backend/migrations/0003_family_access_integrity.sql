ALTER TABLE "family"."reauth_receipts" ADD COLUMN "method" text DEFAULT 'SYNTHETIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "family"."reauth_receipts" ADD COLUMN "assurance" text DEFAULT 'TEST_ONLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "family"."reauth_receipts" ADD COLUMN "adult_exclusive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."registrations" ADD CONSTRAINT "registrationsInIdentity_membership_fk" FOREIGN KEY ("family_id","parent_id") REFERENCES "family"."memberships"("family_id","parent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessionsInIdentity_membership_fk" FOREIGN KEY ("family_id","parent_id") REFERENCES "family"."memberships"("family_id","parent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "registrationsInIdentity_family_idx" ON "identity"."registrations" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessionsInIdentity_family_idx" ON "identity"."sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_registration_idx" ON "identity"."sessions" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "proofs_session_idx" ON "identity"."proofs" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "family"."reauth_receipts" ADD CONSTRAINT "reauth_synthetic_only" CHECK (method = 'SYNTHETIC' AND assurance = 'TEST_ONLY' AND NOT adult_exclusive);