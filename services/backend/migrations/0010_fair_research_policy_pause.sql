-- A transaction-scoped advisory gate gives queued policy writes priority over
-- later readers. The previous tuple-only FOR SHARE lock allowed a later reader
-- to join the row MultiXact while an UPDATE was already waiting.
CREATE OR REPLACE FUNCTION research.lock_policy_version(target_id text)
RETURNS TABLE(policy_active boolean,current_kill_epoch integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('probyu:research.policy_versions',0)
  );
  RETURN QUERY
    SELECT p.active,p.kill_epoch
    FROM research.policy_versions p
    WHERE p.id=target_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION research.lock_policy_version(text) OWNER TO probyu_research_policy_locker;
REVOKE ALL ON FUNCTION research.lock_policy_version(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION research.lock_policy_version(text)
  TO probyu_family_runtime,probyu_research_worker;
REVOKE UPDATE ON research.policy_versions FROM probyu_research_policy_locker;
--> statement-breakpoint
CREATE FUNCTION research.serialize_policy_version_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('probyu:research.policy_versions',0)
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION research.serialize_policy_version_write()
  OWNER TO probyu_research_policy_locker;
REVOKE ALL ON FUNCTION research.serialize_policy_version_write() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER serialize_policy_version_write
BEFORE INSERT OR UPDATE OR DELETE ON research.policy_versions
FOR EACH STATEMENT EXECUTE FUNCTION research.serialize_policy_version_write();
