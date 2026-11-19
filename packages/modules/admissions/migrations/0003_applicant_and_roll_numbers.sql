-- P1-12a: the applicant's own details on an application, and roll numbers issued at acceptance
-- (FUNC-04, FUNC-09, D6, D17 and D21 of plans/P1-12a.md). Erasure and retention reach the new columns.
-- Adds only. Rollback:
--   DROP TABLE IF EXISTS admissions_roll_counters;
--   ALTER TABLE admissions_applications DROP CONSTRAINT IF EXISTS admissions_application_category;
--   ALTER TABLE admissions_applications DROP CONSTRAINT IF EXISTS admissions_application_dob;
--   ALTER TABLE admissions_applications DROP COLUMN IF EXISTS applicant_name, DROP COLUMN IF EXISTS applicant_email,
--     DROP COLUMN IF EXISTS date_of_birth, DROP COLUMN IF EXISTS category;
--   then re-run admissions/0001_dpdp_subject.sql and admissions/0002_retention.sql to restore the previous functions.

-- Pre-flight: admissions 0001 and 0002. No existing row can violate the new checks: the columns are new and nullable.
DO $$
BEGIN
  IF to_regprocedure('dpdp_subject.erase_admissions(text)') IS NULL OR to_regprocedure('dpdp_retention.purge_admissions(uuid)') IS NULL THEN
    RAISE EXCEPTION 'admissions migrations 0001 and 0002 must be applied first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD COLUMN "applicant_name" text;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD COLUMN "applicant_email" text;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_application_category" CHECK (category is null or category in ('general','ews','obc','sc','st'));--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_application_dob" CHECK (date_of_birth is null or date_of_birth >= date '1900-01-01');--> statement-breakpoint
CREATE TABLE "admissions_roll_counters" (
	"institution_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"intake_year" smallint NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "admissions_roll_counters_pk" PRIMARY KEY("institution_id","program_id","intake_year"),
	CONSTRAINT "admissions_roll_counters_value" CHECK (last_value between 0 and 9999),
	CONSTRAINT "admissions_roll_counters_year" CHECK (intake_year between 1900 and 2200)
);--> statement-breakpoint
ALTER TABLE "admissions_roll_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admissions_roll_counters" ADD CONSTRAINT "admissions_roll_counters_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_roll_counters" ADD CONSTRAINT "admissions_roll_counters_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "admissions_roll_counters_tenant_isolation" ON "admissions_roll_counters" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_admissions(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_admissions_enquiries integer := 0;
  n_admissions_applications integer := 0;
BEGIN
  UPDATE admissions_enquiries e SET name = '[erased]', email = 'erased+' || e.id || '@invalid', phone = NULL, note = NULL
    FROM admissions_applications a
   WHERE a.enquiry_id = e.id AND a.student_id = who AND e.name <> '[erased]';
  GET DIAGNOSTICS n_admissions_enquiries = ROW_COUNT;
  UPDATE admissions_applications SET applicant_name = NULL, applicant_email = NULL, date_of_birth = NULL, category = NULL
   WHERE student_id = who AND (applicant_name IS NOT NULL OR applicant_email IS NOT NULL OR date_of_birth IS NOT NULL OR category IS NOT NULL);
  GET DIAGNOSTICS n_admissions_applications = ROW_COUNT;
  RETURN jsonb_build_object('admissions_enquiries', n_admissions_enquiries, 'admissions_applications', n_admissions_applications);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_admissions(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_admissions(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_admissions(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE ids uuid[]; n_enq integer; n_app integer;
BEGIN
  SELECT coalesce(array_agg(e.id), '{}') INTO ids FROM admissions_enquiries e
   WHERE e.institution_id = inst AND e.name <> '[erased]'
     AND NOT EXISTS (SELECT 1 FROM admissions_applications a WHERE a.enquiry_id = e.id AND a.status = 'accepted')
     AND greatest(e.created_at, coalesce((SELECT max(a.updated_at) FROM admissions_applications a WHERE a.enquiry_id = e.id), e.created_at))
         < now() - interval '365 days';
  UPDATE admissions_applications SET reason = NULL, applicant_name = NULL, applicant_email = NULL, date_of_birth = NULL, category = NULL
   WHERE enquiry_id = ANY (ids)
     AND (reason IS NOT NULL OR applicant_name IS NOT NULL OR applicant_email IS NOT NULL OR date_of_birth IS NOT NULL OR category IS NOT NULL);
  GET DIAGNOSTICS n_app = ROW_COUNT;
  UPDATE admissions_enquiries SET name = '[erased]', email = 'erased+' || id || '@invalid', phone = NULL, note = NULL
   WHERE id = ANY (ids);
  GET DIAGNOSTICS n_enq = ROW_COUNT;
  RETURN jsonb_build_object('admissions_enquiries', n_enq, 'admissions_applications', n_app);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_admissions(uuid) FROM PUBLIC;
