CREATE TABLE "background_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "institution_id" uuid NOT NULL REFERENCES "institutions"("id") ON DELETE CASCADE,
  "actor_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "result" jsonb,
  "status" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "run_after" timestamptz NOT NULL DEFAULT now(),
  "lease_until" timestamptz,
  "lease_token" uuid,
  "worker_id" text,
  "error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "background_jobs_status" CHECK (status IN ('queued','running','succeeded','dead')),
  CONSTRAINT "background_jobs_attempts" CHECK (max_attempts BETWEEN 1 AND 10 AND attempts BETWEEN 0 AND max_attempts)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_dedupe" ON "background_jobs"("institution_id", "dedupe_key");
--> statement-breakpoint
CREATE INDEX "background_jobs_due" ON "background_jobs"("institution_id", "status", "run_after");
--> statement-breakpoint
ALTER TABLE "background_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "background_jobs_tenant_isolation" ON "background_jobs" TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
