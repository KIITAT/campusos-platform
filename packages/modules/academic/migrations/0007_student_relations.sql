-- P0-03: the academic relations to a student (SEC-07, decisions 193 and 194).
--
-- Three views in core's student_relations schema (core 0010), each
-- security_invoker so the tables' tenant RLS applies to whoever asks:
--
--   class_teacher  the class teacher of a section the student is in (a new,
--                  nullable column an administrator sets): contact details,
--                  record, admit card, attendance, skills, certificates
--   teaches        the faculty member of an offering whose section the student
--                  is in, while its term runs and for 365 days after: record,
--                  attendance, skills; not contact details
--   hod            the head of the department of a programme the student holds
--                  a live declaration of, or of the programme of a section they
--                  are in: everything, the fee ledger and mentoring included
--
-- Pre-flight: core 0010 has run. Adds only; nothing is rewritten.
--
-- Rollback (loses the class teachers entered since):
--   DROP VIEW student_relations.academic_class_teacher, student_relations.academic_teaches, student_relations.academic_hod;
--   DROP INDEX academic_section_members_user, academic_offerings_faculty;
--   ALTER TABLE academic_sections DROP COLUMN class_teacher_id;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'student_relations') THEN
    RAISE EXCEPTION 'schema student_relations does not exist: run core migration 0010 first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "academic_sections" ADD COLUMN "class_teacher_id" text REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "academic_sections_class_teacher" ON "academic_sections" ("class_teacher_id") WHERE class_teacher_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "academic_section_members_user" ON "academic_section_members" ("user_id");
--> statement-breakpoint
CREATE INDEX "academic_offerings_faculty" ON "academic_offerings" ("faculty_user_id") WHERE faculty_user_id IS NOT NULL;
--> statement-breakpoint
CREATE VIEW student_relations.academic_class_teacher WITH (security_invoker = true) AS
  SELECT s.class_teacher_id AS viewer_id, m.user_id AS student_id, 'class_teacher'::text AS relation,
         ARRAY['profile', 'academic_record', 'admit_card', 'attendance', 'skills', 'certificates']::text[] AS purposes
    FROM public.academic_sections s
    JOIN public.academic_section_members m ON m.section_id = s.id
   WHERE s.class_teacher_id IS NOT NULL;
--> statement-breakpoint
CREATE VIEW student_relations.academic_teaches WITH (security_invoker = true) AS
  SELECT o.faculty_user_id AS viewer_id, m.user_id AS student_id, 'teaches'::text AS relation,
         ARRAY['academic_record', 'attendance', 'skills']::text[] AS purposes
    FROM public.academic_offerings o
    JOIN public.academic_terms t ON t.id = o.term_id
    JOIN public.academic_section_members m ON m.section_id = o.section_id
   WHERE o.faculty_user_id IS NOT NULL
     AND t.ends_on >= current_date - 365;
--> statement-breakpoint
CREATE VIEW student_relations.academic_hod WITH (security_invoker = true) AS
  SELECT d.hod_user_id AS viewer_id, sp.student_id, 'hod'::text AS relation,
         ARRAY['profile', 'academic_record', 'admit_card', 'attendance', 'skills', 'certificates', 'mentoring', 'fee_ledger']::text[] AS purposes
    FROM public.academic_departments d
    JOIN public.academic_programs p ON p.department_id = d.id
    JOIN public.academic_student_programs sp ON sp.program_id = p.id
   WHERE d.hod_user_id IS NOT NULL AND sp.status = 'active' AND sp.declared_on <= current_date
  UNION ALL
  SELECT d.hod_user_id, m.user_id, 'hod'::text,
         ARRAY['profile', 'academic_record', 'admit_card', 'attendance', 'skills', 'certificates', 'mentoring', 'fee_ledger']::text[]
    FROM public.academic_departments d
    JOIN public.academic_programs p ON p.department_id = d.id
    JOIN public.academic_sections s ON s.program_id = p.id
    JOIN public.academic_section_members m ON m.section_id = s.id
   WHERE d.hod_user_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT ON student_relations.academic_class_teacher, student_relations.academic_teaches, student_relations.academic_hod TO campusos_app;
