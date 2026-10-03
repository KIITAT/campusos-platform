-- A student's roll and registration numbers, phone and address: what a hall
-- ticket prints and what an examination enrolment asks the student to confirm.
-- Kept by the office, one row per student, and only for a student.

CREATE TABLE "academic_student_profiles" (
	"student_id" text PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"roll_no" text,
	"registration_no" text,
	"phone" text,
	"address_line" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"emergency_contact" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_student_profiles_phone" CHECK (phone is null or phone ~ '^[0-9+() -]{7,20}$')
);
--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD CONSTRAINT "academic_student_profiles_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD CONSTRAINT "academic_student_profiles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD CONSTRAINT "academic_student_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_student_profiles_roll" ON "academic_student_profiles" USING btree ("institution_id","roll_no");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_student_profiles_registration" ON "academic_student_profiles" USING btree ("institution_id","registration_no");--> statement-breakpoint
CREATE POLICY "academic_student_profiles_tenant_isolation" ON "academic_student_profiles" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION academic_student_profile_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'a profile is kept for a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_student_profile_student';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "academic_student_profiles_guard" BEFORE INSERT OR UPDATE ON "academic_student_profiles"
  FOR EACH ROW EXECUTE FUNCTION academic_student_profile_guard();
