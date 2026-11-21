-- Record search (P1-09c, UX-04): a trigram index for contains-lookups of a pupil's name.
-- Pre-flight: public.users exists and pg_trgm is not installed outside public (aborts otherwise).
-- Rollback (no row changes; keep the extension): DROP INDEX IF EXISTS public.campusos_users_student_name_trgm;
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL OR EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='pg_trgm' AND n.nspname <> 'public'
  ) THEN RAISE EXCEPTION 'record search requires public.users and pg_trgm in public'; END IF;
END $$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint
CREATE INDEX campusos_users_student_name_trgm ON public.users
  USING gin (lower(coalesce(name,'')) public.gin_trgm_ops)
  WHERE role='student' AND erased_at IS NULL;
