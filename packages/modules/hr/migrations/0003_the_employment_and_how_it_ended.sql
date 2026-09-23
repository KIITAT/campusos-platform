-- Employment as a history rather than a set of current values.
--
-- Until now hr_staff carried where somebody is: their designation, their
-- department, whether they had left. That answers "who works here" and nothing
-- else. "What were they when they signed that", "when were they confirmed",
-- "why did they leave and did anybody ask them" are ordinary HR questions with
-- legal weight attached, and none of them can be answered by a row that only
-- knows its latest value.
--
-- So the current values stay where they are, and every change to them becomes a
-- dated row beside them. hr_staff is the answer; hr_employment_changes is the
-- working.

CREATE TYPE "public"."hr_separation_kind" AS ENUM('resignation', 'retirement', 'termination', 'end_of_contract', 'death', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_employment_change" AS ENUM('transfer', 'promotion', 'confirmation', 'grade_change', 'separation');--> statement-breakpoint

-- Grades ---------------------------------------------------------------------
--
-- The band is advisory. A college that hires one person outside its own scale
-- has made a decision; a database that refuses to record what it did only means
-- the real figure lives in a spreadsheet instead.
CREATE TABLE "hr_employee_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rank" smallint DEFAULT 0 NOT NULL,
	"min_paise" bigint,
	"max_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_employee_grades_code_shape" CHECK (length(trim(code)) > 0),
	CONSTRAINT "hr_employee_grades_rank" CHECK (rank between 0 and 999),
	CONSTRAINT "hr_employee_grades_band" CHECK (min_paise is null or max_paise is null or max_paise >= min_paise)
);
--> statement-breakpoint
ALTER TABLE "hr_employee_grades" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_employee_grades" ADD CONSTRAINT "hr_employee_grades_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_employee_grades_code" ON "hr_employee_grades" USING btree ("institution_id","code");--> statement-breakpoint
CREATE INDEX "hr_employee_grades_rank" ON "hr_employee_grades" USING btree ("institution_id","rank");--> statement-breakpoint
CREATE POLICY "hr_employee_grades_tenant_isolation" ON "hr_employee_grades" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "hr_staff" ADD COLUMN "grade_id" uuid;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_grade_id_hr_employee_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."hr_employee_grades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Onboarding -----------------------------------------------------------------
--
-- Template and instance are separate tables because editing the checklist must
-- not rewrite what somebody who joined in March was actually asked to do.
CREATE TABLE "hr_onboarding_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_onboarding_templates_code_shape" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_onboarding_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_onboarding_templates" ADD CONSTRAINT "hr_onboarding_templates_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_onboarding_templates_code" ON "hr_onboarding_templates" USING btree ("institution_id","code");--> statement-breakpoint
CREATE POLICY "hr_onboarding_templates_tenant_isolation" ON "hr_onboarding_templates" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_onboarding_template_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"title" text NOT NULL,
	"owner" text NOT NULL,
	"due_day_offset" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_onboarding_template_activities_range" CHECK (seq between 1 and 200),
	CONSTRAINT "hr_onboarding_template_activities_offset" CHECK (due_day_offset between -365 and 365),
	CONSTRAINT "hr_onboarding_template_activities_title" CHECK (length(trim(title)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_onboarding_template_activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_onboarding_template_activities" ADD CONSTRAINT "hr_onb_tpl_activities_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_onboarding_template_activities" ADD CONSTRAINT "hr_onb_tpl_activities_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."hr_onboarding_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_onboarding_template_activities_seq" ON "hr_onboarding_template_activities" USING btree ("template_id","seq");--> statement-breakpoint
CREATE POLICY "hr_onboarding_template_activities_tenant_isolation" ON "hr_onboarding_template_activities" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_onboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"template_code" text NOT NULL,
	"template_name" text NOT NULL,
	"started_on" date NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_onboardings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_onboardings" ADD CONSTRAINT "hr_onboardings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_onboardings" ADD CONSTRAINT "hr_onboardings_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_onboardings_once" ON "hr_onboardings" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "hr_onboardings_open" ON "hr_onboardings" USING btree ("institution_id","completed_at");--> statement-breakpoint
CREATE POLICY "hr_onboardings_tenant_isolation" ON "hr_onboardings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_onboarding_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"onboarding_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"title" text NOT NULL,
	"owner" text NOT NULL,
	"due_on" date NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_onboarding_activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_onboarding_activities" ADD CONSTRAINT "hr_onboarding_activities_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_onboarding_activities" ADD CONSTRAINT "hr_onboarding_activities_onboarding_id_hr_onboardings_id_fk" FOREIGN KEY ("onboarding_id") REFERENCES "public"."hr_onboardings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_onboarding_activities" ADD CONSTRAINT "hr_onboarding_activities_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_onboarding_activities_seq" ON "hr_onboarding_activities" USING btree ("onboarding_id","seq");--> statement-breakpoint
CREATE INDEX "hr_onboarding_activities_open" ON "hr_onboarding_activities" USING btree ("institution_id","done_at");--> statement-breakpoint
CREATE POLICY "hr_onboarding_activities_tenant_isolation" ON "hr_onboarding_activities" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- Changes and separations ----------------------------------------------------
CREATE TABLE "hr_employment_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" "hr_employment_change" NOT NULL,
	"effective_on" date NOT NULL,
	"from_designation" text,
	"to_designation" text,
	"from_department" text,
	"to_department" text,
	"from_grade" text,
	"to_grade_id" uuid,
	"to_grade" text,
	"from_employment" "hr_employment",
	"to_employment" "hr_employment",
	"reason" text NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_employment_changes_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "hr_employment_changes_something" CHECK (
		kind = 'separation'
		or to_designation is not null
		or to_department is not null
		or to_grade_id is not null
		or to_employment is not null
	)
);
--> statement-breakpoint
ALTER TABLE "hr_employment_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_employment_changes" ADD CONSTRAINT "hr_employment_changes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_changes" ADD CONSTRAINT "hr_employment_changes_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_changes" ADD CONSTRAINT "hr_employment_changes_to_grade_id_hr_employee_grades_id_fk" FOREIGN KEY ("to_grade_id") REFERENCES "public"."hr_employee_grades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_changes" ADD CONSTRAINT "hr_employment_changes_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_employment_changes_staff" ON "hr_employment_changes" USING btree ("staff_id","effective_on");--> statement-breakpoint
CREATE INDEX "hr_employment_changes_when" ON "hr_employment_changes" USING btree ("institution_id","effective_on");--> statement-breakpoint
CREATE POLICY "hr_employment_changes_tenant_isolation" ON "hr_employment_changes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_separations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"change_id" uuid,
	"kind" "hr_separation_kind" NOT NULL,
	"notice_given_on" date,
	"last_day_on" date NOT NULL,
	"reason" text NOT NULL,
	"exit_interview_on" date,
	"exit_interview_by" text,
	"exit_interview_notes" text,
	"rehire_eligible" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_separations_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "hr_separations_notice" CHECK (notice_given_on is null or notice_given_on <= last_day_on),
	CONSTRAINT "hr_separations_interview" CHECK ((exit_interview_on is null) = (exit_interview_notes is null))
);
--> statement-breakpoint
ALTER TABLE "hr_separations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_separations" ADD CONSTRAINT "hr_separations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_separations" ADD CONSTRAINT "hr_separations_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_separations" ADD CONSTRAINT "hr_separations_change_id_hr_employment_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."hr_employment_changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_separations" ADD CONSTRAINT "hr_separations_exit_interview_by_users_id_fk" FOREIGN KEY ("exit_interview_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_separations_once" ON "hr_separations" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "hr_separations_when" ON "hr_separations" USING btree ("institution_id","last_day_on");--> statement-breakpoint
CREATE POLICY "hr_separations_tenant_isolation" ON "hr_separations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- An onboarding is finished when its last activity is ------------------------
--
-- Derived, not asserted. A completion flag somebody sets by hand is a flag that
-- disagrees with the checklist underneath it the first time an activity is
-- reopened, and the checklist is the thing anybody actually acts on.
CREATE OR REPLACE FUNCTION hr_onboarding_completion() RETURNS trigger AS $$
DECLARE
  target uuid;
  outstanding int;
  latest timestamptz;
BEGIN
  -- OLD and NEW are each unassigned for half the operations this fires on, so
  -- the row is chosen rather than coalesced.
  IF TG_OP = 'DELETE' THEN
    target := OLD.onboarding_id;
  ELSE
    target := NEW.onboarding_id;
  END IF;

  SELECT count(*) FILTER (WHERE a.done_at IS NULL), max(a.done_at)
    INTO outstanding, latest
    FROM hr_onboarding_activities a
   WHERE a.onboarding_id = target;

  UPDATE hr_onboardings o
     SET completed_at = CASE WHEN outstanding = 0 THEN latest ELSE NULL END
   WHERE o.id = target
     AND o.completed_at IS DISTINCT FROM (CASE WHEN outstanding = 0 THEN latest ELSE NULL END);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_onboarding_completion
  AFTER INSERT OR UPDATE OR DELETE ON "hr_onboarding_activities"
  FOR EACH ROW EXECUTE FUNCTION hr_onboarding_completion();
--> statement-breakpoint

-- ...and nobody writes that column by hand.
CREATE OR REPLACE FUNCTION hr_onboarding_completed_is_derived() RETURNS trigger AS $$
BEGIN
  IF NEW.completed_at IS DISTINCT FROM OLD.completed_at AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'an onboarding completes when its activities do, not on request'
      USING ERRCODE = 'check_violation',
            HINT = 'complete the outstanding activities instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_onboarding_completed_is_derived
  BEFORE UPDATE ON "hr_onboardings"
  FOR EACH ROW EXECUTE FUNCTION hr_onboarding_completed_is_derived();
--> statement-breakpoint

-- A change belongs inside the employment it changes ---------------------------
--
-- Promoting somebody with effect from before they joined, or a fortnight after
-- they left, is how a payroll ends up paying a stranger. The separation is the
-- one kind allowed to land on the leaving date itself, because that is what it
-- records.
CREATE OR REPLACE FUNCTION hr_employment_change_in_range() RETURNS trigger AS $$
DECLARE
  joined date;
  left_on date;
BEGIN
  SELECT s.joined_on, s.left_on INTO joined, left_on
    FROM hr_staff s WHERE s.id = NEW.staff_id;

  IF joined IS NULL THEN
    RAISE EXCEPTION 'that change refers to a staff record which does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.effective_on < joined THEN
    RAISE EXCEPTION 'nothing about an employment changes before it began on %', joined
      USING ERRCODE = 'check_violation';
  END IF;

  IF left_on IS NOT NULL AND NEW.effective_on > left_on AND NEW.kind <> 'separation' THEN
    RAISE EXCEPTION 'that employment ended on %; nothing changes about it afterwards', left_on
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_employment_change_in_range
  BEFORE INSERT OR UPDATE ON "hr_employment_changes"
  FOR EACH ROW EXECUTE FUNCTION hr_employment_change_in_range();
--> statement-breakpoint

-- A separation and the leaving date are the same fact -------------------------
--
-- Two places recording when somebody left is two places to disagree, and the
-- one payroll reads is hr_staff.left_on. So a separation row may only exist
-- over a staff record that has already been ended, on exactly that day.
CREATE OR REPLACE FUNCTION hr_separation_matches_staff() RETURNS trigger AS $$
DECLARE
  left_on date;
BEGIN
  SELECT s.left_on INTO left_on FROM hr_staff s WHERE s.id = NEW.staff_id;

  IF left_on IS NULL THEN
    RAISE EXCEPTION 'that employment has not been ended, so it cannot be separated'
      USING ERRCODE = 'check_violation',
            HINT = 'end the employment and record the separation in one act';
  END IF;

  IF left_on <> NEW.last_day_on THEN
    RAISE EXCEPTION 'that employment ended on %, not on %', left_on, NEW.last_day_on
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_separation_matches_staff
  BEFORE INSERT OR UPDATE ON "hr_separations"
  FOR EACH ROW EXECUTE FUNCTION hr_separation_matches_staff();
--> statement-breakpoint

-- ...and the leaving date does not quietly move afterwards.
CREATE OR REPLACE FUNCTION hr_staff_left_on_stands() RETURNS trigger AS $$
BEGIN
  IF NEW.left_on IS DISTINCT FROM OLD.left_on
     AND EXISTS (SELECT 1 FROM hr_separations x WHERE x.staff_id = OLD.id)
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'a recorded separation says when that employment ended'
      USING ERRCODE = 'check_violation',
            HINT = 'correct the separation with an audited reason';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_staff_left_on_stands
  BEFORE UPDATE ON "hr_staff"
  FOR EACH ROW EXECUTE FUNCTION hr_staff_left_on_stands();
