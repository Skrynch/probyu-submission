-- Function-only owner: no login, role membership, schema creation or RLS bypass.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='probyu_family_maintenance') THEN
    CREATE ROLE probyu_family_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA identity, family TO probyu_family_maintenance;
GRANT SELECT (id,expires_at,session_id), DELETE ON identity.proofs TO probyu_family_maintenance;
GRANT SELECT (id,expires_at), DELETE ON family.processing_authorizations TO probyu_family_maintenance;
GRANT SELECT (id,expires_at,session_id,registration_id), DELETE ON family.reauth_receipts TO probyu_family_maintenance;
GRANT SELECT (id,expires_at,revoked_at,registration_id), DELETE ON identity.sessions TO probyu_family_maintenance;
GRANT SELECT (id), DELETE ON identity.registrations TO probyu_family_maintenance;
GRANT SELECT (key,window_start), DELETE ON identity.auth_budgets TO probyu_family_maintenance;
GRANT SELECT (reauth_id) ON family.consent_receipts TO probyu_family_maintenance;
--> statement-breakpoint
CREATE POLICY "maintenance_read" ON "identity"."auth_budgets" AS PERMISSIVE FOR SELECT TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_delete" ON "identity"."auth_budgets" AS PERMISSIVE FOR DELETE TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_read" ON "family"."consent_receipts" AS PERMISSIVE FOR SELECT TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_read" ON "family"."processing_authorizations" AS PERMISSIVE FOR SELECT TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_delete" ON "family"."processing_authorizations" AS PERMISSIVE FOR DELETE TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_read" ON "identity"."proofs" AS PERMISSIVE FOR SELECT TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_delete" ON "identity"."proofs" AS PERMISSIVE FOR DELETE TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_read" ON "family"."reauth_receipts" AS PERMISSIVE FOR SELECT TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_delete" ON "family"."reauth_receipts" AS PERMISSIVE FOR DELETE TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_read" ON "identity"."registrations" AS PERMISSIVE FOR SELECT TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_delete" ON "identity"."registrations" AS PERMISSIVE FOR DELETE TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_read" ON "identity"."sessions" AS PERMISSIVE FOR SELECT TO "probyu_family_maintenance" USING (true);--> statement-breakpoint
CREATE POLICY "maintenance_delete" ON "identity"."sessions" AS PERMISSIVE FOR DELETE TO "probyu_family_maintenance" USING (true);
--> statement-breakpoint
ALTER FUNCTION identity.prune_expired_auth() OWNER TO probyu_family_maintenance;
REVOKE ALL ON FUNCTION identity.prune_expired_auth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.prune_expired_auth() TO probyu_family_runtime;
