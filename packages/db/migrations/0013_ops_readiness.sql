-- P0-11: what /api/health reads (REL-02, decision D9 of plans/P0-11.md).
--
-- The app role cannot read drizzle's migration history (no USAGE on the
-- schema) and sees no background job without a tenant (RLS). This function
-- answers two numbers and nothing else: the newest core migration applied, and
-- how long the oldest due, queued job has waited, across institutions.
-- SECURITY DEFINER with a fixed search path; EXECUTE for campusos_app only.
--
-- Adds only. Rollback:
--   DROP FUNCTION public.campusos_readiness();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campusos_app') THEN
    RAISE EXCEPTION 'role campusos_app does not exist. Run docker/init.sql, or the web host''s migrate, first.';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.campusos_readiness()
RETURNS TABLE (core_migrated_at bigint, oldest_due_job_seconds integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    (SELECT pg_catalog.max(m.created_at) FROM drizzle.__drizzle_migrations m),
    (SELECT COALESCE(pg_catalog.floor(EXTRACT(EPOCH FROM (pg_catalog.now() - pg_catalog.min(j.run_after))))::integer, 0)
       FROM public.background_jobs j
      WHERE j.status = 'queued' AND j.run_after <= pg_catalog.now() AND j.attempts < j.max_attempts)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_readiness() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_readiness() TO campusos_app;
