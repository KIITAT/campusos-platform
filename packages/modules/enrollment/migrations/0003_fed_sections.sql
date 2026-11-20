-- P1-07a: sections whose membership follows registration (FUNC-02, decisions 701, 702).
-- A row here marks a section kept for an elective: registering for one of its
-- offerings makes the student a member, and dropping the last one ends it.
-- Pre-flight: the academic sections table exists (a new table; no existing data can violate it).
-- Rollback (owner):
--   DROP TABLE IF EXISTS enrollment_fed_sections;
--   DELETE FROM plugin_migrations WHERE module_id = 'enrollment' AND filename = '0003_fed_sections.sql';
-- Memberships made while a section was marked stay; they are real members.
DO $$
BEGIN
  IF to_regclass('public.academic_sections') IS NULL THEN
    RAISE EXCEPTION 'academic must be installed first: academic_sections is missing';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "enrollment_fed_sections" (
	"institution_id" uuid NOT NULL,
	"section_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrollment_fed_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "enrollment_fed_sections" ADD CONSTRAINT "enrollment_fed_sections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enrollment_fed_sections" ADD CONSTRAINT "enrollment_fed_sections_section_id_academic_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."academic_sections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE POLICY "enrollment_fed_sections_tenant_isolation" ON "enrollment_fed_sections" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
