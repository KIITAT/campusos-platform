-- P1-10c (REL-05): the worker finds institutions with due jobs, and purges finished ones.
-- Pre-flight: none (two functions; no data changes at upgrade).
-- Rollback: DROP FUNCTION campusos_job_tenants(); DROP FUNCTION campusos_purge_jobs();
-- and run the previous web, whose worker calls neither.
CREATE FUNCTION campusos_job_tenants()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT j.institution_id
    FROM background_jobs j
    JOIN institutions i ON i.id = j.institution_id
   WHERE i.suspended_at IS NULL
     AND ((j.status = 'queued' AND j.run_after <= now() AND j.attempts < j.max_attempts)
       OR (j.status = 'running' AND j.lease_until < now()))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION campusos_job_tenants() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION campusos_job_tenants() TO campusos_app;
--> statement-breakpoint
CREATE FUNCTION campusos_purge_jobs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  gone integer;
BEGIN
  DELETE FROM background_jobs WHERE id IN (
    SELECT id FROM background_jobs
     WHERE (status = 'succeeded' AND completed_at < now() - interval '7 days')
        OR (status = 'dead' AND completed_at < now() - interval '30 days')
     LIMIT 10000);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION campusos_purge_jobs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION campusos_purge_jobs() TO campusos_app;
