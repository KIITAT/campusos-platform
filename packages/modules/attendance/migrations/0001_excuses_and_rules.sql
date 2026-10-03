-- Excused absence and the institution's attendance rules (decision 141): a
-- class missed inside an excuse counts as excused, not absent; the minimum a
-- student must keep, whether excused absence counts towards it, and the zone a
-- class's date is read in are the institution's.

CREATE TYPE "public"."attendance_excuse_kind" AS ENUM('medical', 'on_duty', 'leave', 'other');--> statement-breakpoint
CREATE TABLE "attendance_excuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"offering_id" uuid,
	"from_on" date NOT NULL,
	"to_on" date NOT NULL,
	"kind" "attendance_excuse_kind" NOT NULL,
	"reason" text NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_module" text,
	"source_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	CONSTRAINT "attendance_excuses_dates" CHECK (to_on >= from_on),
	CONSTRAINT "attendance_excuses_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "attendance_excuses_revoked" CHECK ((revoked_at is null) = (revoke_reason is null))
);
--> statement-breakpoint
ALTER TABLE "attendance_excuses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_excuses" ADD CONSTRAINT "attendance_excuses_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_excuses" ADD CONSTRAINT "attendance_excuses_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_excuses" ADD CONSTRAINT "attendance_excuses_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_excuses" ADD CONSTRAINT "attendance_excuses_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_excuses" ADD CONSTRAINT "attendance_excuses_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_excuses_student" ON "attendance_excuses" USING btree ("student_id","from_on");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_excuses_source" ON "attendance_excuses" USING btree ("source_module","source_id") WHERE source_id is not null and revoked_at is null;--> statement-breakpoint
CREATE POLICY "attendance_excuses_tenant_isolation" ON "attendance_excuses" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD COLUMN "minimum_percent" smallint DEFAULT 75 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD COLUMN "excused_counts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD COLUMN "time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_minimum" CHECK (minimum_percent between 0 and 100);
--> statement-breakpoint

-- An excuse is for a student, and for one of their own classes when it names
-- one. It is only ever revoked, once, with a reason, and never deleted while
-- the student is.
CREATE OR REPLACE FUNCTION attendance_excuse_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id)
       AND (OLD.offering_id IS NULL OR EXISTS (SELECT 1 FROM academic_offerings WHERE id = OLD.offering_id)) THEN
      RAISE EXCEPTION 'an excuse is revoked, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason']) THEN
      RAISE EXCEPTION 'an excuse is only revoked, once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'an excuse is for a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_student';
  END IF;
  IF NEW.offering_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM academic_offerings o
      JOIN academic_section_members m ON m.section_id = o.section_id AND m.user_id = NEW.student_id
     WHERE o.id = NEW.offering_id) THEN
    RAISE EXCEPTION 'that is not one of the student''s classes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_class';
  END IF;
  NEW.granted_at := now();
  NEW.revoked_at := NULL;
  NEW.revoked_by := NULL;
  NEW.revoke_reason := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "attendance_excuses_guard" BEFORE INSERT OR UPDATE OR DELETE ON "attendance_excuses"
  FOR EACH ROW EXECUTE FUNCTION attendance_excuse_guard();
