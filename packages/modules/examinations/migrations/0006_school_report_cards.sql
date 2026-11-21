-- School term reports (P1-13b, FUNC-03): a grading kind for schools, one
-- validated report template per term and class, and a teacher's observations
-- and publication per pupil. The marks themselves stay in exam_marks; a report
-- is read live from them. Forward-only and additive: no backfill.
-- Roll back the application first. The enum value stays (PostgreSQL cannot drop
-- one); after separately authorised disposal of the records a forward migration
-- drops exam_report_card_entries, then exam_report_card_templates.

ALTER TYPE grading_scheme_kind ADD VALUE IF NOT EXISTS 'school';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS exam_report_card_templates (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES academic_programs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  template jsonb NOT NULL,
  CONSTRAINT exam_report_card_templates_pk PRIMARY KEY (institution_id, term_id, program_id),
  CONSTRAINT exam_report_card_templates_revision CHECK (revision > 0),
  CONSTRAINT exam_report_card_templates_shape CHECK (jsonb_typeof(template) = 'object' AND (template->'version' = '1'::jsonb) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE exam_report_card_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS exam_report_card_templates_tenant_isolation ON exam_report_card_templates;
--> statement-breakpoint
CREATE POLICY exam_report_card_templates_tenant_isolation ON exam_report_card_templates
  AS PERMISSIVE FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS exam_report_card_entries (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES academic_sections(id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grades jsonb NOT NULL DEFAULT '{}'::jsonb,
  remark_key text,
  published_at timestamptz,
  CONSTRAINT exam_report_card_entries_pk PRIMARY KEY (institution_id, term_id, section_id, student_id),
  CONSTRAINT exam_report_card_entries_grades CHECK (jsonb_typeof(grades) = 'object'),
  CONSTRAINT exam_report_card_entries_remark CHECK (remark_key IS NULL OR remark_key ~ '^[a-z][a-z0-9_-]{0,31}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS exam_report_card_entries_student ON exam_report_card_entries(student_id);
--> statement-breakpoint
ALTER TABLE exam_report_card_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS exam_report_card_entries_tenant_isolation ON exam_report_card_entries;
--> statement-breakpoint
CREATE POLICY exam_report_card_entries_tenant_isolation ON exam_report_card_entries
  AS PERMISSIVE FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
