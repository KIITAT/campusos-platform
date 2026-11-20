-- P1-13a: a section's attendance once a day, kept by its class teacher
-- (decisions D6 to D12 of plans/P1-13a.md). One row per student per section
-- per day; absent is an explicit row, unlike a scan session.
--
-- Rollback:
--   DROP TABLE IF EXISTS attendance_daily_marks;

-- Pre-flight: academic sections and attendance excuses exist.
DO $$
BEGIN
  IF to_regclass('public.academic_sections') IS NULL OR to_regclass('public.attendance_excuses') IS NULL THEN
    RAISE EXCEPTION 'academic and attendance 0001 must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "attendance_daily_marks" (
	"institution_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"student_id" text NOT NULL,
	"present" boolean NOT NULL,
	"marked_by" text,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_daily_marks_pk" PRIMARY KEY("section_id","on_date","student_id")
);
--> statement-breakpoint
ALTER TABLE "attendance_daily_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_daily_marks" ADD CONSTRAINT "attendance_daily_marks_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_daily_marks" ADD CONSTRAINT "attendance_daily_marks_section_id_academic_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."academic_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_daily_marks" ADD CONSTRAINT "attendance_daily_marks_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_daily_marks" ADD CONSTRAINT "attendance_daily_marks_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_daily_marks_student" ON "attendance_daily_marks" USING btree ("student_id","on_date");--> statement-breakpoint
CREATE POLICY "attendance_daily_marks_tenant_isolation" ON "attendance_daily_marks" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
