-- Skills (Phase I, decision 130). What a student can do, judged by
-- themselves and by their teachers against a scale the institution writes.
-- Apart from grades: this module reads no mark and writes none.

CREATE TYPE "public"."skill_source" AS ENUM('self', 'faculty');--> statement-breakpoint
CREATE TABLE "skill_frameworks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_frameworks_name_len" CHECK (length(trim(name)) > 0)
);
--> statement-breakpoint
ALTER TABLE "skill_frameworks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"name" text NOT NULL,
	"descriptor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_levels_rank_range" CHECK (rank between 1 and 10),
	CONSTRAINT "skill_levels_descriptor" CHECK (length(trim(descriptor)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "skill_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_skills_code_shape" CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$')
);
--> statement-breakpoint
ALTER TABLE "skill_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"source" "skill_source" NOT NULL,
	"assessor_id" text,
	"evidence" text,
	"assessed_on" date DEFAULT current_date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_assessments_rank_range" CHECK (rank between 1 and 10),
	CONSTRAINT "skill_assessments_evidence" CHECK (source = 'self' or length(trim(coalesce(evidence, ''))) >= 10)
);
--> statement-breakpoint
ALTER TABLE "skill_assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_frameworks" ADD CONSTRAINT "skill_frameworks_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_levels" ADD CONSTRAINT "skill_levels_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_levels" ADD CONSTRAINT "skill_levels_framework_id_skill_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."skill_frameworks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_skills" ADD CONSTRAINT "skill_skills_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_skills" ADD CONSTRAINT "skill_skills_framework_id_skill_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."skill_frameworks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_skill_id_skill_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill_skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_assessor_id_users_id_fk" FOREIGN KEY ("assessor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_frameworks_name" ON "skill_frameworks" USING btree ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_levels_rank" ON "skill_levels" USING btree ("framework_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_skills_code" ON "skill_skills" USING btree ("institution_id","code");--> statement-breakpoint
CREATE INDEX "skill_skills_framework" ON "skill_skills" USING btree ("framework_id");--> statement-breakpoint
CREATE INDEX "skill_assessments_student" ON "skill_assessments" USING btree ("student_id","skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_assessments_skill" ON "skill_assessments" USING btree ("skill_id");--> statement-breakpoint
CREATE POLICY "skill_frameworks_tenant_isolation" ON "skill_frameworks" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skill_levels_tenant_isolation" ON "skill_levels" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skill_skills_tenant_isolation" ON "skill_skills" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skill_assessments_tenant_isolation" ON "skill_assessments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);

--> statement-breakpoint

-- A level a student has been judged against keeps its meaning: it is not
-- rewritten or removed once used. Levels are added, not edited.
CREATE OR REPLACE FUNCTION skill_level_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The framework itself going takes its levels with it (it can only go
  -- when it has no skills, so nobody was judged against them).
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM skill_frameworks WHERE id = OLD.framework_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.framework_id <> OLD.framework_id THEN
    RAISE EXCEPTION 'a level belongs to its framework'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_level_in_use';
  END IF;
  IF EXISTS (SELECT 1 FROM skill_assessments a JOIN skill_skills s ON s.id = a.skill_id
              WHERE s.framework_id = OLD.framework_id AND a.rank = OLD.rank) THEN
    RAISE EXCEPTION 'students have been judged against this level; it is not changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_level_in_use';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "skill_levels_guard" BEFORE UPDATE OR DELETE ON "skill_levels"
  FOR EACH ROW EXECUTE FUNCTION skill_level_guard();
--> statement-breakpoint

-- A skill's code and framework are what its judgements mean.
CREATE OR REPLACE FUNCTION skill_skill_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code OR NEW.framework_id <> OLD.framework_id THEN
    RAISE EXCEPTION 'a skill keeps its code and framework'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_skill_fixed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "skill_skills_guard" BEFORE UPDATE ON "skill_skills"
  FOR EACH ROW EXECUTE FUNCTION skill_skill_guard();
--> statement-breakpoint

-- A judgement: on a level the framework defines, of a live skill, about a
-- student -- by that student, or by a member of staff who is not them. Then
-- it stands as written; the history is the record.
CREATE OR REPLACE FUNCTION skill_assessment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s record;
  student_role text;
  assessor_role text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a judgement is kept; record a new one instead'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- An assessor's account going sets it to null; nothing else moves.
    IF (to_jsonb(NEW) - 'assessor_id') IS DISTINCT FROM (to_jsonb(OLD) - 'assessor_id')
       OR NEW.assessor_id IS NOT NULL AND NEW.assessor_id IS DISTINCT FROM OLD.assessor_id THEN
      RAISE EXCEPTION 'a judgement is kept as written; record a new one instead'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_final';
    END IF;
    RETURN NEW;
  END IF;

  SELECT framework_id, retired_at INTO s FROM skill_skills WHERE id = NEW.skill_id;
  IF s.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'that skill is retired'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_retired';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM skill_levels WHERE framework_id = s.framework_id AND rank = NEW.rank) THEN
    RAISE EXCEPTION 'that level is not on this skill''s scale'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_level';
  END IF;
  SELECT role::text INTO student_role FROM users WHERE id = NEW.student_id;
  IF student_role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'skills are recorded for students'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_student';
  END IF;
  IF NEW.source = 'self' THEN
    IF NEW.assessor_id IS DISTINCT FROM NEW.student_id THEN
      RAISE EXCEPTION 'a self-assessment is by the student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_self';
    END IF;
  ELSE
    SELECT role::text INTO assessor_role FROM users WHERE id = NEW.assessor_id;
    IF NEW.assessor_id = NEW.student_id
       OR assessor_role IS NULL
       OR assessor_role NOT IN ('faculty', 'hod', 'institution_admin', 'super_admin') THEN
      RAISE EXCEPTION 'a teacher''s judgement is by a member of staff'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_assessor';
    END IF;
  END IF;
  IF NEW.assessed_on > current_date THEN
    RAISE EXCEPTION 'a judgement is not dated in the future'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_date';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "skill_assessments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "skill_assessments"
  FOR EACH ROW EXECUTE FUNCTION skill_assessment_guard();
