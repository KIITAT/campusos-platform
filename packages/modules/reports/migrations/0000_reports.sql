-- P2-05: report definitions and their stored runs (MG-57, decisions 487-505).
-- Pre-flight: core 0012 (dpdp_subject) and 0016 (dpdp_retention). New tables only: no existing data.
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_retention.purge_reports(uuid);
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_reports(text);
--   DROP TABLE IF EXISTS reports_runs;
--   DROP TABLE IF EXISTS reports_reports;

DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regnamespace('dpdp_retention') IS NULL THEN
    RAISE EXCEPTION 'core migrations 0012 and 0016 must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "reports_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "institutions"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "dataset" text NOT NULL,
  "spec" jsonb NOT NULL,
  "viewer_roles" text[] DEFAULT '{}'::text[] NOT NULL,
  "on_dashboard" boolean DEFAULT false NOT NULL,
  "schedule" text DEFAULT 'none' NOT NULL,
  "next_run_at" timestamp with time zone,
  "created_by" text NOT NULL REFERENCES "users"("id") ON DELETE no action,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "reports_reports_name" CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT "reports_reports_schedule" CHECK (schedule IN ('none', 'daily', 'weekly', 'monthly')),
  CONSTRAINT "reports_reports_next" CHECK ((schedule = 'none') = (next_run_at IS NULL)),
  CONSTRAINT "reports_reports_tenant_id" UNIQUE ("institution_id", "id")
);
--> statement-breakpoint
CREATE INDEX "reports_reports_due" ON "reports_reports" ("next_run_at") WHERE archived_at IS NULL AND next_run_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "reports_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "institutions"("id") ON DELETE cascade,
  "report_id" uuid NOT NULL,
  "trigger" text NOT NULL,
  "run_by" text REFERENCES "users"("id") ON DELETE no action,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text NOT NULL,
  "error_code" text,
  "row_count" integer DEFAULT 0 NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "on_replica" boolean DEFAULT false NOT NULL,
  "data_as_of" timestamp with time zone,
  "columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT "reports_runs_report" FOREIGN KEY ("institution_id", "report_id") REFERENCES "reports_reports"("institution_id", "id") ON DELETE cascade,
  CONSTRAINT "reports_runs_trigger" CHECK (trigger IN ('manual', 'schedule')),
  CONSTRAINT "reports_runs_status" CHECK (status IN ('ok', 'failed')),
  CONSTRAINT "reports_runs_error" CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT "reports_runs_rows" CHECK (row_count BETWEEN 0 AND 5000)
);
--> statement-breakpoint
CREATE INDEX "reports_runs_latest" ON "reports_runs" ("report_id", "started_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "reports_runs_age" ON "reports_runs" ("institution_id", "started_at");
--> statement-breakpoint
ALTER TABLE "reports_reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reports_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reports_reports_tenant_isolation" ON "reports_reports" AS PERMISSIVE FOR ALL TO "campusos_app"
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "reports_runs_tenant_isolation" ON "reports_runs" AS PERMISSIVE FOR ALL TO "campusos_app"
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reports_reports" TO campusos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "reports_runs" TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_reports(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
  -- A stored run is a cache that may name the person: drop the institution's runs; the next run rebuilds them (decision 495).
  DELETE FROM reports_runs r USING users u WHERE u.id = who AND r.institution_id = u.institution_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('reports_runs', n);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_reports(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_reports(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_reports(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM reports_runs WHERE institution_id = inst AND started_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('reports_runs', n);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_reports(uuid) FROM PUBLIC;
