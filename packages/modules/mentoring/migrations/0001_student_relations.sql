-- P0-03: a mentor or co-mentor of a current assignment (SEC-07, decision 193)
-- sees their mentee's contact details, record, admit card, attendance, skills,
-- certificates and the mentoring itself; not the fee ledger. A view in core's
-- student_relations schema (core 0010), security_invoker.
--
-- Pre-flight: core 0010 has run. Adds only.
-- Rollback: DROP VIEW student_relations.mentoring_mentor;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'student_relations') THEN
    RAISE EXCEPTION 'schema student_relations does not exist: run core migration 0010 first';
  END IF;
END $$;
--> statement-breakpoint
CREATE VIEW student_relations.mentoring_mentor WITH (security_invoker = true) AS
  SELECT a.mentor_id AS viewer_id, a.student_id, 'mentor'::text AS relation,
         ARRAY['profile', 'academic_record', 'admit_card', 'attendance', 'skills', 'certificates', 'mentoring']::text[] AS purposes
    FROM public.mentor_assignments a
   WHERE a.to_on IS NULL
  UNION ALL
  SELECT a.co_mentor_id, a.student_id, 'mentor'::text,
         ARRAY['profile', 'academic_record', 'admit_card', 'attendance', 'skills', 'certificates', 'mentoring']::text[]
    FROM public.mentor_assignments a
   WHERE a.to_on IS NULL AND a.co_mentor_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT ON student_relations.mentoring_mentor TO campusos_app;
