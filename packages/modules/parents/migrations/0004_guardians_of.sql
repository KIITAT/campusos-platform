-- P1-02: who is a current guardian, as one SQL rule other modules can call
-- without depending on parents (UX-02, decision 284). The same rule as
-- childrenOf: a verified link, and for an adult student only a link the
-- student kept (P1-08b).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.campusos_guardians_of(text[]);

-- Pre-flight: parents 0003 (adult_confirmed_at) and core's campusos_age_status.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'parent_links' AND column_name = 'adult_confirmed_at')
     OR to_regprocedure('public.campusos_age_status(text)') IS NULL THEN
    RAISE EXCEPTION 'parents migration 0003 and core 0014 must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.campusos_guardians_of(students text[])
RETURNS TABLE (student_id text, guardian_id text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT l.student_id, l.parent_id
    FROM parent_links l
   WHERE l.student_id = ANY (students)
     AND l.verified_at IS NOT NULL
     AND (public.campusos_age_status(l.student_id) <> 'adult' OR l.adult_confirmed_at IS NOT NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_guardians_of(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_guardians_of(text[]) TO campusos_app;
