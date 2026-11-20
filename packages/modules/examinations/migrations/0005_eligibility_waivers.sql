-- Exam eligibility waivers (P1-07b, FUNC-01): the examination cell's narrow,
-- reversible exception to the attendance or dues check on an enrolment or an
-- admit card. One live row per student, term and check; the reason lives in the
-- audit chain, not here.

CREATE TABLE exam_eligibility_waivers (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  check_kind text NOT NULL,
  CONSTRAINT exam_eligibility_waivers_pk PRIMARY KEY (institution_id, term_id, student_id, check_kind),
  CONSTRAINT exam_eligibility_waivers_kind CHECK (check_kind IN ('attendance', 'dues'))
);
--> statement-breakpoint
CREATE INDEX exam_eligibility_waivers_student ON exam_eligibility_waivers(student_id);
--> statement-breakpoint
ALTER TABLE exam_eligibility_waivers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_eligibility_waivers_tenant_isolation ON exam_eligibility_waivers
  AS PERMISSIVE FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
