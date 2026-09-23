-- Performance: review cycles, key result areas, goals, and structured
-- feedback from colleagues.
--
-- An appraisal runs self review, then the reviewer, then done, and a
-- completed one is a record an increment or a promotion is argued from --
-- so it does not move quietly, and nothing in a closed cycle moves at all.

CREATE TYPE "public"."hr_cycle_status" AS ENUM('draft', 'open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."hr_appraisal_status" AS ENUM('self_review', 'manager_review', 'completed');--> statement-breakpoint
CREATE TYPE "public"."hr_goal_status" AS ENUM('open', 'achieved', 'missed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."hr_feedback_relation" AS ENUM('peer', 'report', 'other');--> statement-breakpoint
CREATE TABLE "hr_appraisal_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "hr_cycle_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_appraisal_cycles_dates" CHECK (ends_on > starts_on)
);
--> statement-breakpoint
ALTER TABLE "hr_appraisal_cycles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_kras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_kras_code_shape" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_kras" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_appraisals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"reviewer_id" text NOT NULL,
	"status" "hr_appraisal_status" DEFAULT 'self_review' NOT NULL,
	"self_summary" text,
	"reviewer_summary" text,
	"score_centi" smallint,
	"self_submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_appraisals_score" CHECK (score_centi is null or score_centi between 100 and 500),
	CONSTRAINT "hr_appraisals_completed" CHECK ((status = 'completed') = (completed_at is not null and score_centi is not null))
);
--> statement-breakpoint
ALTER TABLE "hr_appraisals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_appraisal_kras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"appraisal_id" uuid NOT NULL,
	"kra_id" uuid NOT NULL,
	"weight" smallint NOT NULL,
	"self_rating" smallint,
	"self_comment" text,
	"reviewer_rating" smallint,
	"reviewer_comment" text,
	CONSTRAINT "hr_appraisal_kras_weight" CHECK (weight between 1 and 100),
	CONSTRAINT "hr_appraisal_kras_self" CHECK (self_rating is null or self_rating between 1 and 5),
	CONSTRAINT "hr_appraisal_kras_reviewer" CHECK (reviewer_rating is null or reviewer_rating between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "hr_appraisal_kras" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"cycle_id" uuid,
	"kra_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"target_on" date,
	"progress" smallint DEFAULT 0 NOT NULL,
	"status" "hr_goal_status" DEFAULT 'open' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_goals_progress" CHECK (progress between 0 and 100),
	CONSTRAINT "hr_goals_title" CHECK (length(trim(title)) > 0),
	CONSTRAINT "hr_goals_achieved" CHECK (status <> 'achieved' or progress = 100)
);
--> statement-breakpoint
ALTER TABLE "hr_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_appraisal_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"appraisal_id" uuid NOT NULL,
	"from_user_id" text NOT NULL,
	"relation" "hr_feedback_relation" NOT NULL,
	"strengths" text NOT NULL,
	"improvements" text NOT NULL,
	"rating" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_appraisal_feedback_rating" CHECK (rating between 1 and 5),
	CONSTRAINT "hr_appraisal_feedback_text" CHECK (length(trim(strengths)) >= 5 and length(trim(improvements)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_appraisal_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_appraisal_cycles" ADD CONSTRAINT "hr_appraisal_cycles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_kras" ADD CONSTRAINT "hr_kras_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisals" ADD CONSTRAINT "hr_appraisals_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisals" ADD CONSTRAINT "hr_appraisals_cycle_id_hr_appraisal_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."hr_appraisal_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisals" ADD CONSTRAINT "hr_appraisals_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisals" ADD CONSTRAINT "hr_appraisals_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisal_kras" ADD CONSTRAINT "hr_appraisal_kras_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisal_kras" ADD CONSTRAINT "hr_appraisal_kras_appraisal_id_hr_appraisals_id_fk" FOREIGN KEY ("appraisal_id") REFERENCES "public"."hr_appraisals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisal_kras" ADD CONSTRAINT "hr_appraisal_kras_kra_id_hr_kras_id_fk" FOREIGN KEY ("kra_id") REFERENCES "public"."hr_kras"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_goals" ADD CONSTRAINT "hr_goals_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_goals" ADD CONSTRAINT "hr_goals_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_goals" ADD CONSTRAINT "hr_goals_cycle_id_hr_appraisal_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."hr_appraisal_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_goals" ADD CONSTRAINT "hr_goals_kra_id_hr_kras_id_fk" FOREIGN KEY ("kra_id") REFERENCES "public"."hr_kras"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_goals" ADD CONSTRAINT "hr_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisal_feedback" ADD CONSTRAINT "hr_appraisal_feedback_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisal_feedback" ADD CONSTRAINT "hr_appraisal_feedback_appraisal_id_hr_appraisals_id_fk" FOREIGN KEY ("appraisal_id") REFERENCES "public"."hr_appraisals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_appraisal_feedback" ADD CONSTRAINT "hr_appraisal_feedback_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_appraisal_cycles_name" ON "hr_appraisal_cycles" USING btree ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_kras_code" ON "hr_kras" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_appraisals_once" ON "hr_appraisals" USING btree ("cycle_id","staff_id");--> statement-breakpoint
CREATE INDEX "hr_appraisals_reviewer" ON "hr_appraisals" USING btree ("reviewer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_appraisal_kras_once" ON "hr_appraisal_kras" USING btree ("appraisal_id","kra_id");--> statement-breakpoint
CREATE INDEX "hr_goals_staff" ON "hr_goals" USING btree ("staff_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_appraisal_feedback_once" ON "hr_appraisal_feedback" USING btree ("appraisal_id","from_user_id");--> statement-breakpoint
CREATE POLICY "hr_appraisal_cycles_tenant_isolation" ON "hr_appraisal_cycles" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_kras_tenant_isolation" ON "hr_kras" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_appraisals_tenant_isolation" ON "hr_appraisals" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_appraisal_kras_tenant_isolation" ON "hr_appraisal_kras" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_goals_tenant_isolation" ON "hr_goals" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_appraisal_feedback_tenant_isolation" ON "hr_appraisal_feedback" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- A closed cycle is closed ----------------------------------------------------
--
-- Ratings that change after the review period ended are ratings nobody agreed
-- to. Everything hanging off a closed cycle stops taking writes.
CREATE OR REPLACE FUNCTION hr_cycle_is_open() RETURNS trigger AS $$
DECLARE
  target uuid;
  state hr_cycle_status;
BEGIN
  IF TG_TABLE_NAME = 'hr_appraisals' THEN
    target := NEW.cycle_id;
  ELSE
    SELECT a.cycle_id INTO target FROM hr_appraisals a WHERE a.id = NEW.appraisal_id;
  END IF;
  SELECT c.status INTO state FROM hr_appraisal_cycles c WHERE c.id = target;
  IF state = 'closed' AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'that appraisal cycle is closed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_cycle_is_open
  BEFORE INSERT OR UPDATE ON "hr_appraisals"
  FOR EACH ROW EXECUTE FUNCTION hr_cycle_is_open();
--> statement-breakpoint
CREATE TRIGGER hr_cycle_is_open
  BEFORE INSERT OR UPDATE ON "hr_appraisal_kras"
  FOR EACH ROW EXECUTE FUNCTION hr_cycle_is_open();
--> statement-breakpoint
CREATE TRIGGER hr_cycle_is_open
  BEFORE INSERT OR UPDATE ON "hr_appraisal_feedback"
  FOR EACH ROW EXECUTE FUNCTION hr_cycle_is_open();
--> statement-breakpoint

-- Nobody writes their own 360 ------------------------------------------------
CREATE OR REPLACE FUNCTION hr_feedback_not_self() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM hr_appraisals a JOIN hr_staff s ON s.id = a.staff_id
     WHERE a.id = NEW.appraisal_id AND s.user_id = NEW.from_user_id
  ) THEN
    RAISE EXCEPTION 'feedback on an appraisal comes from somebody other than the person appraised'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_feedback_not_self
  BEFORE INSERT OR UPDATE ON "hr_appraisal_feedback"
  FOR EACH ROW EXECUTE FUNCTION hr_feedback_not_self();
--> statement-breakpoint

-- A completed appraisal is a record ------------------------------------------
--
-- It is what an increment, a promotion or a confirmation is argued from, and it
-- does not move without somebody saying why.
CREATE OR REPLACE FUNCTION hr_appraisal_completed_stands() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed'
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'a completed appraisal is not changed without an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_appraisal_completed_stands
  BEFORE UPDATE ON "hr_appraisals"
  FOR EACH ROW EXECUTE FUNCTION hr_appraisal_completed_stands();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hr_appraisal_kra_completed_stands() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hr_appraisals a WHERE a.id = OLD.appraisal_id AND a.status = 'completed')
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'a completed appraisal is not changed without an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_appraisal_kra_completed_stands
  BEFORE UPDATE ON "hr_appraisal_kras"
  FOR EACH ROW EXECUTE FUNCTION hr_appraisal_kra_completed_stands();
