-- Academic core, finished. Applied by the host at install time, in this order.
--
-- Everything here is additive: departments, programmes, terms, courses,
-- cohorts, offerings and slots keep the shape attendance, examinations and fees
-- already reference. What was missing was the part a registrar actually works
-- from --
--
--   * a term that knows what kind of term it is, and its own calendar
--   * curricula, so requirements belong to a catalogue year rather than to
--     whatever the registrar last edited
--   * the prerequisite graph, its overrides, and cross-listing
--   * a student's declared programmes, plural
--   * what a student has actually completed, transfer credit included
--
-- The last of those is the seam the examinations module posts into when a
-- result is finalised, which is how the registrar's numbers and the examiner's
-- stay the same numbers.

CREATE TYPE "public"."academic_term_kind" AS ENUM('regular', 'summer', 'winter');--> statement-breakpoint
CREATE TYPE "public"."academic_requirement_kind" AS ENUM('core', 'elective', 'open');--> statement-breakpoint
CREATE TYPE "public"."academic_prerequisite_kind" AS ENUM('prerequisite', 'corequisite');--> statement-breakpoint
CREATE TYPE "public"."academic_enrolment_status" AS ENUM('active', 'completed', 'withdrawn', 'transferred_out');--> statement-breakpoint
CREATE TYPE "public"."academic_completion_source" AS ENUM('internal', 'transfer');--> statement-breakpoint

-- The calendar ------------------------------------------------------------
ALTER TABLE "academic_terms" ADD COLUMN "kind" "academic_term_kind" DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "academic_terms" ADD COLUMN "registration_opens_on" date;--> statement-breakpoint
ALTER TABLE "academic_terms" ADD COLUMN "registration_closes_on" date;--> statement-breakpoint
ALTER TABLE "academic_terms" ADD COLUMN "add_drop_ends_on" date;--> statement-breakpoint
ALTER TABLE "academic_terms" ADD COLUMN "withdraw_ends_on" date;--> statement-breakpoint
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_calendar" CHECK (
  (registration_closes_on is null or registration_opens_on is null
    or registration_closes_on >= registration_opens_on)
  and (add_drop_ends_on is null or add_drop_ends_on >= starts_on)
  and (withdraw_ends_on is null or add_drop_ends_on is null
    or withdraw_ends_on >= add_drop_ends_on)
  and (withdraw_ends_on is null or withdraw_ends_on <= ends_on)
);--> statement-breakpoint

CREATE TABLE "academic_curricula" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"catalog_year" smallint NOT NULL,
	"total_credits" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_curricula_year" CHECK (catalog_year between 1900 and 2200),
	CONSTRAINT "academic_curricula_credits" CHECK (total_credits between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "academic_curricula" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "academic_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"curriculum_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"kind" "academic_requirement_kind" NOT NULL,
	"min_credits" smallint DEFAULT 0 NOT NULL,
	"min_courses" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_requirements_minimums" CHECK (min_credits >= 0 and min_courses >= 0 and (min_credits > 0 or min_courses > 0))
);
--> statement-breakpoint
ALTER TABLE "academic_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "academic_requirement_courses" (
	"institution_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_requirement_courses_pk" PRIMARY KEY("requirement_id","course_id")
);
--> statement-breakpoint
ALTER TABLE "academic_requirement_courses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "academic_prerequisites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"requires_course_id" uuid NOT NULL,
	"kind" "academic_prerequisite_kind" DEFAULT 'prerequisite' NOT NULL,
	"min_grade_points" numeric(4, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_prerequisites_self" CHECK (course_id <> requires_course_id)
);
--> statement-breakpoint
ALTER TABLE "academic_prerequisites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "academic_prerequisite_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"course_id" uuid NOT NULL,
	"requires_course_id" uuid,
	"reason" text NOT NULL,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_prerequisite_waivers_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "academic_prerequisite_waivers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "academic_course_equivalences" (
	"institution_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"equivalent_course_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_course_equivalences_pk" PRIMARY KEY("course_id","equivalent_course_id"),
	CONSTRAINT "academic_course_equivalences_self" CHECK (course_id <> equivalent_course_id)
);
--> statement-breakpoint
ALTER TABLE "academic_course_equivalences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "academic_student_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"program_id" uuid NOT NULL,
	"curriculum_id" uuid,
	"status" "academic_enrolment_status" DEFAULT 'active' NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"declared_on" date DEFAULT now() NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_student_programs_ended" CHECK ((status = 'active') = (ended_on is null))
);
--> statement-breakpoint
ALTER TABLE "academic_student_programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "academic_course_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"course_id" uuid NOT NULL,
	"term_id" uuid,
	"credits" smallint NOT NULL,
	"grade_points" numeric(4, 2),
	"grade_label" text,
	"passed" boolean DEFAULT true NOT NULL,
	"source" "academic_completion_source" DEFAULT 'internal' NOT NULL,
	"note" text,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_course_completions_credits" CHECK (credits between 0 and 30)
);
--> statement-breakpoint
ALTER TABLE "academic_course_completions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Foreign keys -------------------------------------------------------------
ALTER TABLE "academic_curricula" ADD CONSTRAINT "academic_curricula_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_curricula" ADD CONSTRAINT "academic_curricula_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "academic_requirements" ADD CONSTRAINT "academic_requirements_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_requirements" ADD CONSTRAINT "academic_requirements_curriculum_id_academic_curricula_id_fk" FOREIGN KEY ("curriculum_id") REFERENCES "public"."academic_curricula"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "academic_requirement_courses" ADD CONSTRAINT "academic_requirement_courses_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_requirement_courses" ADD CONSTRAINT "academic_requirement_courses_requirement_id_academic_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."academic_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_requirement_courses" ADD CONSTRAINT "academic_requirement_courses_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "academic_prerequisites" ADD CONSTRAINT "academic_prerequisites_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_prerequisites" ADD CONSTRAINT "academic_prerequisites_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_prerequisites" ADD CONSTRAINT "academic_prerequisites_requires_course_id_academic_courses_id_fk" FOREIGN KEY ("requires_course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "academic_prerequisite_waivers" ADD CONSTRAINT "academic_prerequisite_waivers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_prerequisite_waivers" ADD CONSTRAINT "academic_prerequisite_waivers_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_prerequisite_waivers" ADD CONSTRAINT "academic_prerequisite_waivers_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_prerequisite_waivers" ADD CONSTRAINT "academic_prerequisite_waivers_requires_course_id_academic_courses_id_fk" FOREIGN KEY ("requires_course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_prerequisite_waivers" ADD CONSTRAINT "academic_prerequisite_waivers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "academic_course_equivalences" ADD CONSTRAINT "academic_course_equivalences_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_course_equivalences" ADD CONSTRAINT "academic_course_equivalences_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_course_equivalences" ADD CONSTRAINT "academic_course_equivalences_equivalent_course_id_academic_courses_id_fk" FOREIGN KEY ("equivalent_course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "academic_student_programs" ADD CONSTRAINT "academic_student_programs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_student_programs" ADD CONSTRAINT "academic_student_programs_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_student_programs" ADD CONSTRAINT "academic_student_programs_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_student_programs" ADD CONSTRAINT "academic_student_programs_curriculum_id_academic_curricula_id_fk" FOREIGN KEY ("curriculum_id") REFERENCES "public"."academic_curricula"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "academic_course_completions" ADD CONSTRAINT "academic_course_completions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_course_completions" ADD CONSTRAINT "academic_course_completions_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_course_completions" ADD CONSTRAINT "academic_course_completions_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_course_completions" ADD CONSTRAINT "academic_course_completions_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_course_completions" ADD CONSTRAINT "academic_course_completions_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Indexes ------------------------------------------------------------------
CREATE UNIQUE INDEX "academic_curricula_identity" ON "academic_curricula" USING btree ("program_id","catalog_year");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_requirements_code" ON "academic_requirements" USING btree ("curriculum_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_prerequisites_edge" ON "academic_prerequisites" USING btree ("course_id","requires_course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_prerequisite_waivers_once" ON "academic_prerequisite_waivers" USING btree ("student_id","course_id","requires_course_id") WHERE requires_course_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_prerequisite_waivers_blanket" ON "academic_prerequisite_waivers" USING btree ("student_id","course_id") WHERE requires_course_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_student_programs_live" ON "academic_student_programs" USING btree ("student_id","program_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "academic_student_programs_primary" ON "academic_student_programs" USING btree ("student_id") WHERE is_primary and status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "academic_course_completions_attempt" ON "academic_course_completions" USING btree ("student_id","course_id","term_id");--> statement-breakpoint
CREATE INDEX "academic_course_completions_student" ON "academic_course_completions" USING btree ("student_id");--> statement-breakpoint

-- Tenant isolation ---------------------------------------------------------
CREATE POLICY "academic_curricula_tenant_isolation" ON "academic_curricula" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_requirements_tenant_isolation" ON "academic_requirements" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_requirement_courses_tenant_isolation" ON "academic_requirement_courses" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_prerequisites_tenant_isolation" ON "academic_prerequisites" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_prerequisite_waivers_tenant_isolation" ON "academic_prerequisite_waivers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_course_equivalences_tenant_isolation" ON "academic_course_equivalences" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_student_programs_tenant_isolation" ON "academic_student_programs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_course_completions_tenant_isolation" ON "academic_course_completions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- A chain that eats its own tail -------------------------------------------
--
-- Two courses that require each other are unsatisfiable: nobody can ever take
-- either. It is an easy edit to make one department at a time and impossible to
-- see from the form, so the graph refuses to close rather than the page
-- refusing to render. Checked against the whole transitive chain, not just the
-- reverse edge -- A requires B requires C requires A is the one that gets past
-- a shallow check.
CREATE OR REPLACE FUNCTION academic_prereq_no_cycle() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE reach(course_id) AS (
      SELECT NEW.requires_course_id
      UNION
      SELECT p.requires_course_id
        FROM academic_prerequisites p
        JOIN reach r ON p.course_id = r.course_id
    )
    SELECT 1 FROM reach WHERE course_id = NEW.course_id
  ) THEN
    RAISE EXCEPTION 'that prerequisite closes a loop: the course it requires already depends on it'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER academic_prerequisites_no_cycle
  BEFORE INSERT OR UPDATE ON academic_prerequisites
  FOR EACH ROW EXECUTE FUNCTION academic_prereq_no_cycle();
