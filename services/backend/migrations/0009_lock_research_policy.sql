-- Runtime can serialize a policy-dependent transaction with the administrator's
-- UPDATE without receiving permission to change the policy itself.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='probyu_research_policy_locker') THEN
    CREATE ROLE probyu_research_policy_locker NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA research TO probyu_research_policy_locker;
GRANT SELECT, UPDATE ON research.policy_versions TO probyu_research_policy_locker;
--> statement-breakpoint
CREATE FUNCTION research.lock_policy_version(target_id text)
RETURNS TABLE(policy_active boolean,current_kill_epoch integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p.active,p.kill_epoch
  FROM research.policy_versions p
  WHERE p.id=target_id
  FOR SHARE OF p
$$;
--> statement-breakpoint
ALTER FUNCTION research.lock_policy_version(text) OWNER TO probyu_research_policy_locker;
REVOKE ALL ON FUNCTION research.lock_policy_version(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION research.lock_policy_version(text) TO probyu_family_runtime;
