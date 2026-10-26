-- Two things the application role used to do directly, and lost in 0005.
--
-- 0005 took every grant on the Auth.js tables and every write on institutions
-- and institution_modules away from the application role (SEC-05). Two product
-- paths needed a sliver of that, and each gets it here as a function that runs
-- as its owner, answers for the tenant the transaction is already scoped to
-- (`app.institution_id`, the same rule as campusos_address_taken_elsewhere),
-- and does one thing.
--
-- Forward-only. Rollback is a later migration that drops both functions; the
-- callers would then fail closed (permission denied), not open.

-- A background job checks that its institution is not suspended and its module
-- is enabled, and holds both rows FOR SHARE until it commits, so a suspension
-- waits for the jobs already running rather than racing them. FOR SHARE needs
-- UPDATE privilege, which the application role no longer has on either table.
-- The locks are taken here instead, inside the job's own transaction, and only
-- on the caller's own tenant.
CREATE FUNCTION campusos_job_gate(tenant uuid, module text)
RETURNS TABLE (is_active boolean, is_enabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF tenant IS DISTINCT FROM nullif(current_setting('app.institution_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a job may only check its own institution'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i.suspended_at IS NULL INTO is_active
    FROM institutions i WHERE i.id = tenant FOR SHARE;
  IF module IS NOT NULL THEN
    SELECT m.enabled INTO is_enabled
      FROM institution_modules m
     WHERE m.institution_id = tenant AND m.module_id = module FOR SHARE;
  END IF;
  RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION campusos_job_gate(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION campusos_job_gate(uuid, text) TO campusos_app;
--> statement-breakpoint

-- Withdrawing a guardian's invitation is a safeguarding act and takes effect
-- now: their account goes back to pending and their sessions end, in the same
-- transaction as the withdrawal and its audit row. The application role cannot
-- touch `sessions` any more, so the ending happens here -- for one person, and
-- only a person in the caller's own institution.
CREATE FUNCTION campusos_end_sessions(target text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ended integer;
BEGIN
  DELETE FROM sessions s
   USING users u
   WHERE s."userId" = target
     AND u.id = target
     AND u.institution_id = nullif(current_setting('app.institution_id', true), '')::uuid;
  GET DIAGNOSTICS ended = ROW_COUNT;
  RETURN ended;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION campusos_end_sessions(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION campusos_end_sessions(text) TO campusos_app;
