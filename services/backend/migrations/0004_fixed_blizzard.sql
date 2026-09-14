CREATE TABLE "identity"."auth_budgets" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_budgets_key_check" CHECK (key ~ '^[a-f0-9]{64}$'::text)
);
--> statement-breakpoint
ALTER TABLE "identity"."auth_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "family"."command_receipts" ADD COLUMN "reauth_id" uuid;--> statement-breakpoint
CREATE POLICY "budget_scope" ON "identity"."auth_budgets" AS PERMISSIVE FOR ALL TO public USING (key = current_setting('app.budget_key',true)) WITH CHECK (key = current_setting('app.budget_key',true));
--> statement-breakpoint
ALTER TABLE identity.auth_budgets FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON identity.auth_budgets TO probyu_family_runtime;
-- A fixed, bounded maintenance operation; runtime receives no general DELETE or RLS bypass.
CREATE FUNCTION identity.prune_expired_auth() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM identity.proofs WHERE id IN (
    SELECT id FROM identity.proofs WHERE expires_at < clock_timestamp() LIMIT 1000);
  DELETE FROM family.processing_authorizations WHERE id IN (
    SELECT id FROM family.processing_authorizations WHERE expires_at < clock_timestamp() LIMIT 1000);
  DELETE FROM family.reauth_receipts WHERE id IN (
    SELECT r.id FROM family.reauth_receipts r WHERE r.expires_at < clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM family.consent_receipts c WHERE c.reauth_id=r.id) LIMIT 1000);
  DELETE FROM identity.sessions WHERE id IN (
    SELECT s.id FROM identity.sessions s WHERE
      (s.expires_at < clock_timestamp() OR s.revoked_at < clock_timestamp() - interval '1 day')
      AND NOT EXISTS(SELECT 1 FROM identity.proofs p WHERE p.session_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM family.reauth_receipts r WHERE r.session_id=s.id) LIMIT 1000);
  DELETE FROM identity.registrations WHERE id IN (
    SELECT r.id FROM identity.registrations r
    WHERE NOT EXISTS(SELECT 1 FROM identity.sessions s WHERE s.registration_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM family.reauth_receipts p WHERE p.registration_id=r.id) LIMIT 1000);
  DELETE FROM identity.auth_budgets WHERE key IN (
    SELECT key FROM identity.auth_budgets WHERE window_start < clock_timestamp() - interval '1 day' LIMIT 1000);
END $$;
REVOKE ALL ON FUNCTION identity.prune_expired_auth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.prune_expired_auth() TO probyu_family_runtime;
