-- Timetable (ERP phase 2, decision 154): the week's periods, who may teach
-- what and when they cannot, what each class needs a week, what the office has
-- pinned, and the draft timetables the solver produces until one is applied to
-- the academic core's live slots.

CREATE TABLE "timetable_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"max_per_day" smallint DEFAULT 6 NOT NULL,
	"max_per_week" smallint DEFAULT 24 NOT NULL,
	"max_consecutive" smallint DEFAULT 3 NOT NULL,
	"year_starts_month" smallint DEFAULT 7 NOT NULL,
	"time_limit_seconds" smallint DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_settings_limits" CHECK (max_per_day between 1 and 16 and max_per_week between 1 and 80 and max_consecutive between 1 and 16),
	CONSTRAINT "timetable_settings_month" CHECK (year_starts_month between 1 and 12),
	CONSTRAINT "timetable_settings_time" CHECK (time_limit_seconds between 1 and 600)
);
--> statement-breakpoint
ALTER TABLE "timetable_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid,
	"day_of_week" smallint NOT NULL,
	"idx" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_periods_identity" UNIQUE NULLS NOT DISTINCT("institution_id","term_id","day_of_week","idx"),
	CONSTRAINT "timetable_periods_day" CHECK (day_of_week between 1 and 7),
	CONSTRAINT "timetable_periods_index" CHECK (idx between 1 and 30),
	CONSTRAINT "timetable_periods_times" CHECK (ends_at > starts_at)
);
--> statement-breakpoint
ALTER TABLE "timetable_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_rooms" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"kind" text DEFAULT 'classroom' NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	CONSTRAINT "timetable_rooms_kind" CHECK (kind ~ '^[a-z0-9][a-z0-9 _:-]{0,39}$')
);
--> statement-breakpoint
ALTER TABLE "timetable_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_sections" (
	"section_id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"expected_size" smallint,
	"parent_section_id" uuid,
	CONSTRAINT "timetable_sections_size" CHECK (expected_size is null or expected_size between 1 and 2000),
	CONSTRAINT "timetable_sections_parent" CHECK (parent_section_id is null or parent_section_id <> section_id)
);
--> statement-breakpoint
ALTER TABLE "timetable_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_teachers" (
	"user_id" text PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"max_per_day" smallint,
	"max_per_week" smallint,
	"max_consecutive" smallint,
	"note" text,
	CONSTRAINT "timetable_teachers_limits" CHECK ((max_per_day is null or max_per_day between 1 and 16) and (max_per_week is null or max_per_week between 0 and 80) and (max_consecutive is null or max_consecutive between 1 and 16))
);
--> statement-breakpoint
ALTER TABLE "timetable_teachers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_eligibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"course_id" uuid,
	"department_id" uuid,
	"program_id" uuid,
	"year_of_study" smallint,
	"preference" smallint DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_eligibility_identity" UNIQUE NULLS NOT DISTINCT("user_id","course_id","department_id","program_id","year_of_study"),
	CONSTRAINT "timetable_eligibility_names_something" CHECK (course_id is not null or department_id is not null or program_id is not null or year_of_study is not null),
	CONSTRAINT "timetable_eligibility_year" CHECK (year_of_study is null or year_of_study between 1 and 10),
	CONSTRAINT "timetable_eligibility_preference" CHECK (preference between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "timetable_eligibility" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_unavailable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text,
	"room_id" uuid,
	"section_id" uuid,
	"day_of_week" smallint NOT NULL,
	"period" smallint,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_unavailable_one" CHECK (num_nonnulls(user_id, room_id, section_id) = 1),
	CONSTRAINT "timetable_unavailable_day" CHECK (day_of_week between 1 and 7),
	CONSTRAINT "timetable_unavailable_period" CHECK (period is null or period between 1 and 30)
);
--> statement-breakpoint
ALTER TABLE "timetable_unavailable" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_needs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"kind" text DEFAULT 'lecture' NOT NULL,
	"periods_per_week" smallint NOT NULL,
	"block_length" smallint DEFAULT 1 NOT NULL,
	"room_kind" text,
	"room_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_needs_kind" CHECK (kind ~ '^[a-z][a-z0-9_-]{0,23}$'),
	CONSTRAINT "timetable_needs_periods" CHECK (periods_per_week between 1 and 40 and block_length between 1 and 6 and periods_per_week % block_length = 0)
);
--> statement-breakpoint
ALTER TABLE "timetable_needs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"need_kind" text,
	"faculty_user_id" text,
	"day_of_week" smallint,
	"period" smallint,
	"room_id" uuid,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_pins_something" CHECK (faculty_user_id is not null or day_of_week is not null),
	CONSTRAINT "timetable_pins_time" CHECK ((day_of_week is null) = (period is null)),
	CONSTRAINT "timetable_pins_room" CHECK (room_id is null or day_of_week is not null),
	CONSTRAINT "timetable_pins_day" CHECK (day_of_week is null or day_of_week between 1 and 7)
);
--> statement-breakpoint
ALTER TABLE "timetable_pins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"seed" integer NOT NULL,
	"options" jsonb NOT NULL,
	"teachers" jsonb NOT NULL,
	"cost" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"unplaced" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "timetable_runs_status" CHECK (status in ('draft', 'applied', 'discarded', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "timetable_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetable_run_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"need_kind" text NOT NULL,
	"faculty_user_id" text,
	"room_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"period" smallint NOT NULL,
	"length" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"fixed" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timetable_run_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timetable_settings" ADD CONSTRAINT "timetable_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_periods" ADD CONSTRAINT "timetable_periods_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_periods" ADD CONSTRAINT "timetable_periods_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_rooms" ADD CONSTRAINT "timetable_rooms_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_rooms" ADD CONSTRAINT "timetable_rooms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_sections" ADD CONSTRAINT "timetable_sections_section_id_academic_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."academic_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_sections" ADD CONSTRAINT "timetable_sections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_sections" ADD CONSTRAINT "timetable_sections_parent_section_id_academic_sections_id_fk" FOREIGN KEY ("parent_section_id") REFERENCES "public"."academic_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_teachers" ADD CONSTRAINT "timetable_teachers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_teachers" ADD CONSTRAINT "timetable_teachers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_eligibility" ADD CONSTRAINT "timetable_eligibility_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_eligibility" ADD CONSTRAINT "timetable_eligibility_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_eligibility" ADD CONSTRAINT "timetable_eligibility_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_eligibility" ADD CONSTRAINT "timetable_eligibility_department_id_academic_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."academic_departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_eligibility" ADD CONSTRAINT "timetable_eligibility_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_unavailable" ADD CONSTRAINT "timetable_unavailable_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_unavailable" ADD CONSTRAINT "timetable_unavailable_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_unavailable" ADD CONSTRAINT "timetable_unavailable_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_unavailable" ADD CONSTRAINT "timetable_unavailable_section_id_academic_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."academic_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_needs" ADD CONSTRAINT "timetable_needs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_needs" ADD CONSTRAINT "timetable_needs_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_needs" ADD CONSTRAINT "timetable_needs_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_pins" ADD CONSTRAINT "timetable_pins_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_pins" ADD CONSTRAINT "timetable_pins_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_pins" ADD CONSTRAINT "timetable_pins_faculty_user_id_users_id_fk" FOREIGN KEY ("faculty_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_pins" ADD CONSTRAINT "timetable_pins_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_runs" ADD CONSTRAINT "timetable_runs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_runs" ADD CONSTRAINT "timetable_runs_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run_entries" ADD CONSTRAINT "timetable_run_entries_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run_entries" ADD CONSTRAINT "timetable_run_entries_run_id_timetable_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."timetable_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run_entries" ADD CONSTRAINT "timetable_run_entries_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run_entries" ADD CONSTRAINT "timetable_run_entries_faculty_user_id_users_id_fk" FOREIGN KEY ("faculty_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run_entries" ADD CONSTRAINT "timetable_run_entries_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_eligibility_course" ON "timetable_eligibility" USING btree ("institution_id","course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_needs_identity" ON "timetable_needs" USING btree ("offering_id","kind");--> statement-breakpoint
CREATE INDEX "timetable_runs_term" ON "timetable_runs" USING btree ("institution_id","term_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_runs_one_applied" ON "timetable_runs" USING btree ("term_id") WHERE status = 'applied';--> statement-breakpoint
CREATE INDEX "timetable_run_entries_run" ON "timetable_run_entries" USING btree ("run_id","day_of_week","period");--> statement-breakpoint
CREATE POLICY "timetable_settings_tenant_isolation" ON "timetable_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_periods_tenant_isolation" ON "timetable_periods" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_rooms_tenant_isolation" ON "timetable_rooms" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_sections_tenant_isolation" ON "timetable_sections" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_teachers_tenant_isolation" ON "timetable_teachers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_eligibility_tenant_isolation" ON "timetable_eligibility" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_unavailable_tenant_isolation" ON "timetable_unavailable" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_needs_tenant_isolation" ON "timetable_needs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_pins_tenant_isolation" ON "timetable_pins" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_runs_tenant_isolation" ON "timetable_runs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "timetable_run_entries_tenant_isolation" ON "timetable_run_entries" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- Two periods of one day in one week do not overlap: the standing week (no
-- term) and each term's own week are separate weeks.
ALTER TABLE "timetable_periods"
  ADD CONSTRAINT "timetable_periods_no_overlap"
  EXCLUDE USING gist (
    "institution_id" WITH =,
    (coalesce("term_id", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    "day_of_week" WITH =,
    tsrange('2000-01-01'::date + "starts_at", '2000-01-01'::date + "ends_at") WITH &&
  );
