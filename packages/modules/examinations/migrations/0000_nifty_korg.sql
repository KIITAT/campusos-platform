-- Split from the monorepo history (0004_nifty_korg.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

CREATE TYPE "public"."exam_kind" AS ENUM('quiz', 'assignment', 'midterm', 'practical', 'final');
--> statement-breakpoint
CREATE TYPE "public"."grading_scheme_kind" AS ENUM('percentage', 'gpa', 'custom');
--> statement-breakpoint
CREATE TABLE "exam_grade_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"min_percent" numeric(6, 2) NOT NULL,
	"label" text NOT NULL,
	"points" numeric(4, 2),
	"is_pass" boolean DEFAULT true NOT NULL,
	CONSTRAINT "exam_bands_percent" CHECK (min_percent between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "exam_grade_bands" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "exam_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"obtained" numeric(6, 2),
	"absent" boolean DEFAULT false NOT NULL,
	"entered_by" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "exam_marks_obtained" CHECK (obtained is null or obtained >= 0),
	CONSTRAINT "exam_marks_absent_has_no_score" CHECK (not absent or obtained is null)
);
--> statement-breakpoint
ALTER TABLE "exam_marks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "exam_kind" NOT NULL,
	"max_marks" numeric(6, 2) NOT NULL,
	"weight_percent" numeric(6, 2) NOT NULL,
	"scheduled_at" timestamp with time zone,
	"room_id" uuid,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exams_max_marks" CHECK (max_marks > 0),
	CONSTRAINT "exams_weight" CHECK (weight_percent > 0 and weight_percent <= 100)
);
--> statement-breakpoint
ALTER TABLE "exams" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "exam_grading_schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "grading_scheme_kind" NOT NULL,
	"max_points" numeric(4, 2),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exam_grading_schemes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "exam_grade_bands" ADD CONSTRAINT "exam_grade_bands_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_grade_bands" ADD CONSTRAINT "exam_grade_bands_scheme_id_exam_grading_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."exam_grading_schemes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exam_grading_schemes" ADD CONSTRAINT "exam_grading_schemes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_bands_floor" ON "exam_grade_bands" USING btree ("scheme_id","min_percent");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_marks_once" ON "exam_marks" USING btree ("exam_id","student_id");
--> statement-breakpoint
CREATE INDEX "exam_marks_student" ON "exam_marks" USING btree ("student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exams_name" ON "exams" USING btree ("offering_id","name");
--> statement-breakpoint
CREATE INDEX "exams_offering" ON "exams" USING btree ("offering_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_schemes_name" ON "exam_grading_schemes" USING btree ("institution_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "exam_schemes_one_default" ON "exam_grading_schemes" USING btree ("institution_id") WHERE is_default;
--> statement-breakpoint
CREATE POLICY "exam_grade_bands_tenant_isolation" ON "exam_grade_bands" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "exam_marks_tenant_isolation" ON "exam_marks" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "exams_tenant_isolation" ON "exams" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "exam_grading_schemes_tenant_isolation" ON "exam_grading_schemes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
