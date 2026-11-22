-- P1-02b (review finding 1): one partial index per claim lane, so e-mail fan-out never starves other jobs.
-- Pre-flight: none (two indexes on background_jobs, a short write lock; the table is purged to a few days).
-- Rollback: DROP INDEX background_jobs_claim_other; DROP INDEX background_jobs_claim_email; DROP FUNCTION campusos_google_verified(text);
-- the previous worker still claims through background_jobs_due.
CREATE INDEX "background_jobs_claim_other" ON "background_jobs" USING btree ("institution_id","run_after","created_at") WHERE kind <> 'notices.email' and status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "background_jobs_claim_email" ON "background_jobs" USING btree ("institution_id","run_after","created_at") WHERE kind = 'notices.email' and status in ('queued', 'running');
--> statement-breakpoint
-- Notification e-mail goes only to an address its owner has proven: a magic-link sign-in
-- sets "emailVerified"; a Google sign-in proves the address without setting it. The
-- application role cannot read "accounts" (0005), so this answers for one user of the
-- caller's own institution and nothing else.
CREATE FUNCTION campusos_google_verified(target text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounts a JOIN users u ON u.id = a."userId"
     WHERE a."userId" = target AND a.provider = 'google'
       AND u.institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION campusos_google_verified(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION campusos_google_verified(text) TO campusos_app;
