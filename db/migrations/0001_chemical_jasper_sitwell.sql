CREATE TYPE "public"."academic_program_level" AS ENUM('certificate', 'diploma', 'undergraduate', 'postgraduate', 'doctoral');--> statement-breakpoint
CREATE TABLE "academic_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"credits" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_courses_credits" CHECK (credits between 0 and 30)
);
--> statement-breakpoint
ALTER TABLE "academic_courses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"hod_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "academic_departments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"faculty_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "academic_offerings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"level" "academic_program_level" NOT NULL,
	"duration_terms" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_programs_duration" CHECK (duration_terms between 1 and 24)
);
--> statement-breakpoint
ALTER TABLE "academic_programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"building" text,
	"capacity" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "academic_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_section_members" (
	"institution_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_section_members_section_id_user_id_pk" PRIMARY KEY("section_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "academic_section_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"label" text NOT NULL,
	"admission_year" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_sections_year" CHECK (admission_year between 1900 and 2200)
);
--> statement-breakpoint
ALTER TABLE "academic_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_slots_day" CHECK (day_of_week between 1 and 7),
	CONSTRAINT "academic_slots_times" CHECK (ends_at > starts_at)
);
--> statement-breakpoint
ALTER TABLE "academic_slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "academic_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_terms_dates" CHECK (ends_on > starts_on)
);
--> statement-breakpoint
ALTER TABLE "academic_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "academic_courses" ADD CONSTRAINT "academic_courses_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_courses" ADD CONSTRAINT "academic_courses_department_id_academic_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."academic_departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_departments" ADD CONSTRAINT "academic_departments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_departments" ADD CONSTRAINT "academic_departments_hod_user_id_users_id_fk" FOREIGN KEY ("hod_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_offerings" ADD CONSTRAINT "academic_offerings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_offerings" ADD CONSTRAINT "academic_offerings_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_offerings" ADD CONSTRAINT "academic_offerings_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_offerings" ADD CONSTRAINT "academic_offerings_section_id_academic_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."academic_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_offerings" ADD CONSTRAINT "academic_offerings_faculty_user_id_users_id_fk" FOREIGN KEY ("faculty_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_programs" ADD CONSTRAINT "academic_programs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_programs" ADD CONSTRAINT "academic_programs_department_id_academic_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."academic_departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_rooms" ADD CONSTRAINT "academic_rooms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_section_members" ADD CONSTRAINT "academic_section_members_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_section_members" ADD CONSTRAINT "academic_section_members_section_id_academic_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."academic_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_section_members" ADD CONSTRAINT "academic_section_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_sections" ADD CONSTRAINT "academic_sections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_sections" ADD CONSTRAINT "academic_sections_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_slots" ADD CONSTRAINT "academic_slots_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_slots" ADD CONSTRAINT "academic_slots_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_slots" ADD CONSTRAINT "academic_slots_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_courses_code" ON "academic_courses" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_departments_code" ON "academic_departments" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_offerings_identity" ON "academic_offerings" USING btree ("term_id","course_id","section_id");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_programs_code" ON "academic_programs" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_rooms_code" ON "academic_rooms" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_sections_identity" ON "academic_sections" USING btree ("institution_id","program_id","admission_year","label");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_terms_code" ON "academic_terms" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_terms_one_current" ON "academic_terms" USING btree ("institution_id") WHERE is_current;--> statement-breakpoint
CREATE POLICY "academic_courses_tenant_isolation" ON "academic_courses" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_departments_tenant_isolation" ON "academic_departments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_offerings_tenant_isolation" ON "academic_offerings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_programs_tenant_isolation" ON "academic_programs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_rooms_tenant_isolation" ON "academic_rooms" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_section_members_tenant_isolation" ON "academic_section_members" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_sections_tenant_isolation" ON "academic_sections" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_slots_tenant_isolation" ON "academic_slots" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "academic_terms_tenant_isolation" ON "academic_terms" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);