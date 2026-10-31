-- P1-08b: date of birth, age status and guardian consent records (AUD-04).
-- Adds only; no row can violate a nullable column or a new table.
-- Rollback:
--   DROP TABLE IF EXISTS guardian_consents;
--   DROP TRIGGER IF EXISTS users_dob_guard ON users;
--   DROP FUNCTION IF EXISTS campusos_users_dob_guard();
--   DROP FUNCTION IF EXISTS public.campusos_age_status(text);
--   ALTER TABLE users DROP COLUMN IF EXISTS date_of_birth;
CREATE TABLE "guardian_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"purpose" text NOT NULL,
	"decision" text NOT NULL,
	"basis" text NOT NULL,
	"guardian_id" text,
	"recorded_by" text,
	"note" text,
	"notice_version" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "guardian_consents_purpose" CHECK (purpose in ('privacy_notice', 'care_self_checks', 'apaar')),
	CONSTRAINT "guardian_consents_decision" CHECK (decision in ('given', 'refused', 'withdrawn')),
	CONSTRAINT "guardian_consents_basis" CHECK (basis in ('guardian', 'office_record', 'student')),
	CONSTRAINT "guardian_consents_basis_guardian" CHECK ((basis = 'guardian') = (guardian_id is not null)),
	CONSTRAINT "guardian_consents_office_note" CHECK (basis <> 'office_record' or note is not null),
	CONSTRAINT "guardian_consents_note" CHECK (note is null or length(note) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "guardian_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "guardian_consents" ADD CONSTRAINT "guardian_consents_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_consents" ADD CONSTRAINT "guardian_consents_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_consents" ADD CONSTRAINT "guardian_consents_guardian_id_users_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_consents" ADD CONSTRAINT "guardian_consents_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guardian_consents_latest" ON "guardian_consents" USING btree ("institution_id","student_id","purpose","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "guardian_consents_tenant_isolation" ON "guardian_consents" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "guardian_consents" FROM campusos_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "guardian_consents" TO campusos_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION campusos_users_dob_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.date_of_birth IS NOT NULL AND (NEW.date_of_birth < date '1900-01-01' OR NEW.date_of_birth > current_date) THEN
    RAISE EXCEPTION 'a date of birth is in the past'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_date_of_birth_range';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER users_dob_guard BEFORE INSERT OR UPDATE OF date_of_birth ON "users"
  FOR EACH ROW EXECUTE FUNCTION campusos_users_dob_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.campusos_age_status(who text) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN u.date_of_birth IS NULL THEN 'unknown'
    WHEN u.date_of_birth > ((now() AT TIME ZONE 'Asia/Kolkata')::date - interval '18 years')::date THEN 'minor'
    ELSE 'adult' END
  FROM (SELECT 1) one LEFT JOIN users u ON u.id = who
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_age_status(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_age_status(text) TO campusos_app;
