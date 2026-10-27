-- P0-03: a student registered into an offering is taught by its faculty member
-- (SEC-07, decision 193), while its term runs and for 365 days after, as
-- academic's own `teaches` relation: record, attendance, skills. A view in
-- core's student_relations schema (core 0010), security_invoker.
--
-- Pre-flight: core 0010 and academic 0007 have run. Adds only.
-- Rollback: DROP VIEW student_relations.enrollment_teaches;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'student_relations') THEN
    RAISE EXCEPTION 'schema student_relations does not exist: run core migration 0010 first';
  END IF;
END $$;
--> statement-breakpoint
CREATE VIEW student_relations.enrollment_teaches WITH (security_invoker = true) AS
  SELECT o.faculty_user_id AS viewer_id, r.student_id, 'teaches'::text AS relation,
         ARRAY['academic_record', 'attendance', 'skills']::text[] AS purposes
    FROM public.enrollment_registrations r
    JOIN public.academic_offerings o ON o.id = r.offering_id
    JOIN public.academic_terms t ON t.id = o.term_id
   WHERE r.status = 'registered' AND o.faculty_user_id IS NOT NULL
     AND t.ends_on >= current_date - 365;
--> statement-breakpoint
GRANT SELECT ON student_relations.enrollment_teaches TO campusos_app;
