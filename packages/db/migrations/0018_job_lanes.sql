-- P1-02b (review finding 1): one partial index per claim lane, so e-mail fan-out never starves other jobs.
-- Pre-flight: none (two indexes on background_jobs, a short write lock; the table is purged to a few days).
-- Rollback: DROP INDEX background_jobs_claim_other; DROP INDEX background_jobs_claim_email;
-- the previous worker still claims through background_jobs_due.
CREATE INDEX "background_jobs_claim_other" ON "background_jobs" USING btree ("institution_id","run_after","created_at") WHERE kind <> 'notices.email' and status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "background_jobs_claim_email" ON "background_jobs" USING btree ("institution_id","run_after","created_at") WHERE kind = 'notices.email' and status in ('queued', 'running');